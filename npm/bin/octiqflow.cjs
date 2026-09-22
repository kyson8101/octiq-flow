#!/usr/bin/env node

const { main } = require('../lib/cli.cjs');

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`octiqflow: ${error.message}`);
    process.exitCode = 1;
  });
