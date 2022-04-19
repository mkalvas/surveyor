# surveyor

<img width="460" alt="project" src="https://user-images.githubusercontent.com/6921907/163902208-6b669e79-c5a9-4406-82f6-befa05643a94.png">

A dependency analysis and visualization tool for projects using ES6 imports and exports.

This script is rough and ready. It was written to analyze [a specific modular architecture that I use](https://mkalvas.com/blog/code-organization) inside of a Next.js application. That said, it could be easily extended to analyze other projects with different folder/file structures. There would simply need to be some changes to the node and edge labeling process and the file/directory inclusion matchers.

PRs, Issues, and feedback are all welcome, but I make no guarantee of timeliness or quality of support.

## Dependencies

- [Neo4j](https://neo4j.com) running locally
- [NVM](https://github.com/nvm-sh/nvm) (or just Node.js of a compatible version) for using the node version in `.nvmrc`
- NPM or similar for installing node dependencies:
  - [`cli-progress`](https://github.com/npkgz/cli-progress) for progress bars
  - [`neo4j-driver`](https://github.com/neo4j/neo4j-javascript-driver) for connecting to the Neo4j database

## Usage

You need to be in a certain state to run the script:

1. Your Neo4j database is running and available from the machine you're running this script on. See [configuring](#configuring) for more. 🚨 **THIS SCRIPT WILL WIPE WHATEVER DB YOU POINT IT AT AND START CLEAN** 🚨.
2. You've [configured](#configuring) the other settings to suit your needs.

```sh
git clone git@github.com:mkalvas/surveyor.git
cd surveyor
npm install
npm start
```

### Configuring

There's a [`cfg`](./index.js#L7) object that contains some basic settings that can be configured.

```js
const cfg = {
  // absolute path to the root of your project
  root: `${path.resolve('../../some-path')}/`,

  // connection information for the Neo4j database
  // (these are the defaults for a local instance)
  connection: 'bolt://localhost:7687',
  user: 'neo4j',
  database: 'neo4j',
  password: 'password',

  // Some inclusion/exclusion matching for files and dirs
  includeDir: /(src|pages)/, // picked to work well with Next.js
  includeFile: /\.(t|j)sx?$/,

  // `includeRoot` is because I want the root variable to be the root of
  // the project but don't want things like `.eslintrc.js` to be included
  // in the results
  includeRoot: false,
};
```

Other than that, you're on your own with changing the code, but since it's not complicated, it should be pretty straightforward.

In general, the code follows this flow:

1. **Wipe the DB**
2. Get all the files that should be analyzed by recursively matching on the `includeDir`, `includeFile`, and `includeRoot` settings.
3. Insert nodes which correspond to the list of files from the previous step. The nodes include some metadata and labeling that are based on the file path and name.
4. Read and parse source code from each file to create a list of import statements. This includes things like pulling apart renames and multiple imports into individual records.
5. Deduplicate the list of import statements.
6. Insert edges corresponding to the import statements. The edges are directed from the import**ing** file to the import**ed** file. They also include metadata about the import.
7. Clean up the DB connection and exit the program.

### Some useful queries

Lastly, I've recorded some simple queries in Cypher that might be interesting. I'm no expert, so these may be **slow**.

#### General Tips

- The `Connect result nodes` setting in Neo4j Desktop is useful and not at the same time, make sure it's using the preferred setting for each query.
- `collect(r)[0]` limits to one relationship, handy for performance and cleanliness of output

#### Queries

```sql
-- Get everything
match (n) return n

-- Everything, excluding imports from feature index files.
-- Useful for finding imports that are breaking the "public feature contract convention".
-- Coloring the nodes in Neo4j Desktop based on module labels is a great way to see this.
-- This shows module cohesion and coupling really well.
match (i)-[r]->(e) where not e:Feature and not i:Feature return i,r,e

-- More explicitly ONLY the nodes breaking the "public contract convention"
match (i)-[r]->(e) where i.module <> e.module and not e:Feature return i,r,e

-- All imports from one module to a different module
match (i)-[r]->(e) where i.module <> e.module return i,r,e

-- Look at one module and limit connections to a single line.
-- Might not find orphaned nodes in that module though with the way this is queried.
match (i)-[r]->(e { module: 'SomeModule' }) return i,collect(r)[0],e
```

## Roadmap

None, but this code is pretty rough so I might make some updates. In particular, I don't like the global files/imports arrays that are "just available for mutations" in methods.
