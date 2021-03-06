#!/usr/bin/env node
/*
Copyright (c) 2018 Advay Mengle <source@madvay.com>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
'use strict';

require('./envconfig')
const yargs = require('yargs')
const pkgVersion = require('./package.json').version

try {
  yargs.commandDir('commands')
    .demandCommand()
    .help('help', 'Displays usage help for commands')
    .option('debug', {
      boolean: true,
      desc: 'Exercises functionality just for debugging - do not use in production'
    })
    .option('outputdir', {
      string: true,
      alias: 'o',
      default: './output/',
      desc: 'Where to dump generated diffs, tweets, images, etc. Must exist.'
    })
    .option('db', {
      string: true,
      default: './persist.yaml',
      desc: 'R/W file to persist fire info.'
    })
    .option('port', {
      number: true,
      default: 8080,
      desc: 'Web server port'
    })
    .scriptName('firemon')
    .recommendCommands()
    .strict()
    .version('version', 'Displays package version', pkgVersion)
    .wrap(yargs.terminalWidth())
    .parse()
} catch (err) {
  throw err
}