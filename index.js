/* eslint-disable */
const fs = require('fs');
const path = require('path');
const neo4j = require('neo4j-driver');
const progress = require('cli-progress');

const cfg = {
  root: `${path.resolve('../../beam-frontend')}/`,
  connection: 'bolt://localhost:7687',
  user: 'neo4j',
  database: 'neo4j',
  password: 'password',
  includeDir: /(src|pages)/,
  includeFile: /\.(t|j)sx?$/,
  includeRoot: false,
};

const IMPORT_REGEX =
  /import (?:["'\s]*([\w*{}\n, ]+)from\s*)?["'\s]*([\.@\w\/_-]+)["'\s]*;?/gm;
const EXPORT_REGEX =
  /export (?:["'\s]*([\w*{}\n, ]+))?from\s*["'\s]*([\.@\w\/_-]+)["'\s]*;?/gm;

const driver = neo4j.driver(
  cfg.connection,
  neo4j.auth.basic(cfg.user, cfg.password)
);

driver.verifyConnectivity();
const session = driver.session({
  database: cfg.database,
  defaultAccessMode: neo4j.session.WRITE,
});

const execute = async (query, params) => {
  await session.run(query, params).catch((err) => console.error(err));
};

const wipeDatabase = async () => {
  await execute('MATCH (n) DETACH DELETE n');
};

const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1);

const createNodes = async (nodes, incrementProgressBar) => {
  for (node of nodes) {
    const file = node.replace(cfg.root, '').split('.')[0];
    const parts = file.split('/');
    const name = parts.at(-1) === 'index' ? parts.at(-2) : parts.at(-1);
    const module = parts[1].split('-').map(capitalize).join('');

    const page = /^pages/.test(file);
    const feature = /src\/\w+\/index$/.test(file);
    const type = feature ? 'Feature' : page ? 'Page' : 'File';
    const spec = /\/specs\//.test(file);
    const pact = /\/pacts\//.test(file);
    const fixture = /\/fixtures\//.test(file);
    const labels = [
      type,
      ...(type === 'File' ? [module] : []),
      ...(spec ? ['Spec'] : []),
      ...(pact ? ['Pact'] : []),
      ...(fixture ? ['Fixture'] : []),
    ].join(':');

    const params = { feature, file, fixture, module, name, pact, page, spec };
    await execute(
      `CREATE (n:${labels} {
        name: $name,
        file: $file,
        feature: $feature,
        module: $module,
        spec: $spec,
        pact: $pact,
        page: $page,
        fixture: $fixture
      })`,
      params
    );
    incrementProgressBar();
  }
};

const createEdges = async (imports, incrementProgressBar) => {
  for (imp of imports) {
    await execute(
      `MATCH (a), (b)
       WHERE a.file = $in AND b.file = $from
       CREATE (a)-[:IMPORTS {
         item: $name,
         as: $as,
         in: $in,
         from: $from,
         sideEffectsOnly: $sideEffectsOnly
       }]->(b)`,
      imp
    );
    incrementProgressBar();
  }
};

const getSourceFiles = (dir, bar) => {
  const includeRoot = dir === cfg.root ? cfg.includeRoot : true;
  const filesInDir = fs.readdirSync(dir);
  bar.setTotal(bar.getTotal() + filesInDir.length);

  for (file of filesInDir) {
    const absolute = path.join(dir, file);
    if (fs.statSync(absolute).isDirectory()) {
      if (cfg.includeDir.test(absolute)) getSourceFiles(absolute, bar);
    } else {
      if (includeRoot && cfg.includeFile.test(absolute)) files.push(absolute);
    }
    bar.increment();
  }
};

const getImports = (files, regex, incrementProgressBar) => {
  for (file of files) {
    const source = fs.readFileSync(file, 'utf-8').toString();
    const statements = source.matchAll(regex);
    for (statement of statements) {
      let sideEffectsOnly = false;
      let [raw, importString, module] = statement;

      // handles 'import "package"'
      if (!importString && raw && module) {
        importString = module;
        sideEffectsOnly = true;
      }

      const strippedFile = file.split('.')[0];
      module = module.startsWith('.')
        ? path.join(strippedFile, '..', module)
        : module;
      module = module.replace(`${cfg.root}`, '');
      if (/^src\/\w+$/.test(module)) {
        module += '/index';
      }

      const parsed = parseImports(importString);
      imports.push(
        ...parsed.map((parsed) => ({
          in: strippedFile.replace(`${cfg.root}`, ''),
          ...parsed,
          from: module,
          sideEffectsOnly,
        }))
      );
    }
    incrementProgressBar();
  }
};

const parseImports = (importString) => {
  let items = importString.split(',');
  if (!/(\{|\*)/g.test(items[0])) {
    // handles 'import Foo from "package"'
    items[0] = `default as ${items[0]}`;
  }
  return items
    .filter((i) => !/ \{\}/.test(i))
    .map((i) => {
      const singleImport = i.replace(/(\{|\}|\n)/g, '').trim();
      const renames = singleImport.match(/(.*)\s+as\s+(.*)/);
      if (renames) {
        return { name: renames[1].trim(), as: renames[2].trim() };
      } else {
        return { name: singleImport, as: singleImport };
      }
    });
};

/* ========================================================================== */
/*                                  SCRIPT                                    */
/* ========================================================================== */

let files = [];
let imports = [];

const main = async () => {
  const bar = new progress.MultiBar({
    autopadding: true,
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    clearOnComplete: false,
    format: `{task} |{bar}| {percentage}% | {value}/{total}`,
    hideCursor: true,
  });

  try {
    // WIPE DB
    const wipeProgress = bar.create(1, 0, { task: '            wiping db' });
    await wipeDatabase();
    wipeProgress.update(1);

    // LOAD SOURCE CODE
    const sourceProgress = bar.create(1, 0, { task: '  loading source code' });
    getSourceFiles(path.join(cfg.root), sourceProgress);
    sourceProgress.update(sourceProgress.getTotal());

    // INSERT NODES
    const nodeProgress = bar.create(files.length, 0, {
      task: '      inserting nodes',
    });
    await createNodes(files, () => nodeProgress.increment());
    nodeProgress.update(files.length);

    // PARSE IMPORTS
    const importsProgress = bar.create(files.length * 2, 0, {
      task: '      parsing imports',
    });
    getImports(files, EXPORT_REGEX, () => importsProgress.increment());
    getImports(files, IMPORT_REGEX, () => importsProgress.increment());
    importsProgress.update(files.length * 2);

    // DEDUPE
    const dedupeInitial = imports.length;
    const dedupeProgress = bar.create(dedupeInitial, 0, {
      task: '     deduping imports',
    });
    const dedupe = new Set(
      imports.map((i) => {
        dedupeProgress.increment();
        return JSON.stringify(i);
      })
    );
    dedupeProgress.update(dedupe.size);
    dedupeProgress.setTotal(dedupeInitial + dedupe.size);
    imports = [...dedupe].map((i) => {
      dedupeProgress.increment();
      return JSON.parse(i);
    });
    dedupeProgress.update(dedupeInitial + dedupe.size);

    // INSERT EDGES
    const edgeProgress = bar.create(imports.length, 0, {
      task: '      inserting edges',
    });
    await createEdges(imports, () => edgeProgress.increment());
  } finally {
    // FINALIZE
    const cleanupProgress = bar.create(2, 0, { task: '          cleaning up' });
    await session.close();
    cleanupProgress.increment();
    await driver.close();
    cleanupProgress.increment();
    bar.stop();
  }
};

main();
