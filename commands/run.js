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

exports.command = 'run';

exports.aliases = ['daemon'];

exports.description = 'Runs a daemon to post updates';

exports.builder = {
  once: {
    boolean: true,
    desc: 'Run only once and then exit'
  },
  twitter: {
    boolean: true,
    desc: 'Whether to post to Twitter'
  }
}

exports.handler = argv => {

  const os = require('os');
  const rp = require('request-promise');
  const _ = require('lodash');
  const yaml = require('js-yaml');
  const titleCase = require('title-case');
  const webshot = require('webshot');
  const pug = require('pug');
  const fs = require('fs');
  const deepDiff = require('deep-diff');
  const express = require('express');
  const serveIndex = require('serve-index');
  const numeral = require('numeral');

  const envconfig = require('../envconfig');
  const dateString = require('../lib/util').dateString;
  const maprender = require('../lib/maprender');
  const geomac = require('../lib/geomac');

  const webshotSemaphore = require('semaphore')(1);

  const webApp = express();

  const mkdirp = require('mkdirp');

  const tmpdir = os.tmpdir() + '/firemon/';

  mkdirp.sync(tmpdir + '/img/src/terrain');
  mkdirp.sync(tmpdir + '/img/src/detail');
  mkdirp.sync(argv.outputdir + '/img');
  mkdirp.sync(argv.outputdir + '/tweets');
  mkdirp.sync(argv.outputdir + '/postqueue');
  mkdirp.sync(argv.outputdir + '/data');

  webApp.use('/updates', express.static(argv.outputdir + '/'), serveIndex(argv.outputdir + '/', { icons: true, view: 'details' }));
  webApp.listen(argv.port);

  const fireHashTag = function (name) {
    let r = '#' + titleCase(name.trim()).split(' ').join('') + 'Fire';
    while (r.endsWith('ComplexFire')) {
      r = r.substring(0, r.length - 'Fire'.length);
    }
    while (r.endsWith('FireFire')) {
      r = r.substring(0, r.length - 'Fire'.length);
    }
    return r;
  }


  const processFire = function (entry) {
    let ret = {};
    for (var key in entry) {
      ret[key] = entry[key];
      if (key.endsWith('DateTime')) {
        ret[key] = dateString(ret[key]);
      }
      if (_.isString(ret[key])) {
        ret[key] = ret[key].trim();
      }
    }
    ret['Hashtag'] = fireHashTag(ret.Name);
    return ret;
  };


  const dataOptions = {
    uri: 'https://maps.nwcg.gov/sa/publicData.json',
    qs: {
    },
    headers: {
      'User-Agent': 'Request-Promise'
    },
    json: true
  };


  const config = {
    twitterName: envconfig.twitterAuth.name,
    sourceUrl: dataOptions.uri,
    disclaimerUrl: envconfig.ui.disclaimer_url,
  };


  const htmlTemplate = pug.compileFile('fireUpdateRender.pug');
  const genHtml = function (entry) {
    return htmlTemplate({ config: config, data: entry, curdir: process.cwd() });
  };

  const tweetTemplate = pug.compileFile('fireUpdateTweet.pug');

  const genTweet = function (entry) {
    return tweetTemplate({ config: config, data: entry, curdir: process.cwd() });
  };

  if (argv.twitter) {
    const t = require('../lib/twitter');
    t.launchDaemon(argv.outputdir + '/postqueue/');
  }

  const REMOVE_forceDeltaDebug = argv.debug;
  const periodSeq = argv.debug ? 5 : 65;

  const mainLoop = function (first, last) {
    //console.log(' >> main loop');
    rp(dataOptions).then(function (layers) {
      //console.log(' >> received data');
      let outstanding = 0;
      let x = last;
      try {

        const layer = layers[0].layerConfigs[0 /*featureCollection.layerDefinition.name == 'Large WF'*/]
        const data = layer.featureCollection.featureSet.features;
        x = _.keyBy(data.map(e => processFire(e.attributes)), o => o.UniqueFireIdentifier);
        // console.log('%s', yaml.safeDump(x));

        const globalUpdateId = 'Update-at-' + dateString(new Date().getTime());

        if (REMOVE_forceDeltaDebug && !first) {
          const bs = ['2018-CASHF-001444','2018-WAOWF-000443','2018-CASHF-001438'];
          for (var bsi in bs) {
            const bsk = bs[bsi];
            if (!x[bsk]) { continue; }
            x[bsk].Fire_Name = 'TEST FAKE ' + x[bsk].Fire_Name;
            x[bsk].Hashtag = '#TestOnly' + x[bsk].Hashtag.substr(1);
            x[bsk].ModifiedOnDateTime = dateString(new Date().getTime());
            x[bsk].PercentContained = last[bsk].PercentContained + 7.3;
            x[bsk].DailyAcres = last[bsk].DailyAcres + 55;
            x[bsk].EstimatedCostToDate = last[bsk].EstimatedCostToDate - 34455;
            x[bsk].TotalIncidentPersonnel = last[bsk].TotalIncidentPersonnel + 55;
          }
        }

        //fs.writeFileSync('./testimgs/GLOBAL-LHS-' + globalUpdateId + '.yaml', yaml.safeDump(last));
        //fs.writeFileSync('./testimgs/GLOBAL-RHS-' + globalUpdateId + '.yaml', yaml.safeDump(x));

        console.log('Writing ' + globalUpdateId);

        const diffGlobal = deepDiff(last, x) || [];

        const diffsGlobal = yaml.safeDump(diffGlobal);

        fs.writeFileSync(argv.outputdir + '/data/GLOBAL-DIFF-' + globalUpdateId + '.yaml', diffsGlobal);

        // max fires to process.
        //let c = 2000;

        outstanding++;


        geomac.getPerimeters((perims, err) => {

          //console.log(perims);

          try {
            if (err) {
              throw err;
            }
            for (var i in x) {

              
              if (first) {
                continue;
              }
              const cur = x[i];

              const perim = ((cur.UniqueFireIdentifier in perims) ? (perims[cur.UniqueFireIdentifier].geometry.rings) : []) || [];
              //console.log(perims);
              //console.log(perim);

              if (!perim) {
                continue;
              }

              if (i in last && last[i].ModifiedOnDateTime == cur.ModifiedOnDateTime) {
                continue;
              }

              const updateId = 'Update-' + cur.ModifiedOnDateTime + '-of-' + i + ' named ' + cur.Name;

              const old = last[i] || {};

              let oneDiff = deepDiff(old, cur);
              oneDiff = _.keyBy(oneDiff, o => o.path.join('.'));

              if (!('DailyAcres' in oneDiff || 'PercentContained' in oneDiff)) {
                // Unless acreage or containment change, we don't report it.
                continue;
              }


              const diffs = yaml.safeDump(oneDiff || []);
              const isNew = !(i in last);

              console.log('- ' + updateId);

              fs.writeFileSync(argv.outputdir + '/data/DIFF-' + updateId + '.yaml', diffs);


              console.log('   # Before webshotSemaphore ' + updateId);
              outstanding++;

              webshotSemaphore.take(function () {
                try {
                  console.log('   # Entering webshotSemaphore ' + updateId);
                  const infoImg = argv.outputdir + '/img/IMG-' + updateId + '.png';
                  const terrainMapImg = tmpdir + '/img/src/terrain/MAP-TERRAIN-' + updateId + '.png';
                  const detailMapImg = tmpdir + '/img/src/detail/MAP-DETAIL-' + updateId + '.png';

                  const doWebshot = (terrainPath, detailPath) => {
                    const terrainImg64 = terrainPath ? fs.readFileSync(terrainPath, {encoding: 'base64'}) : null;
                    const templateData = { 
                      current: cur, 
                      last: old, 
                      diff: oneDiff, 
                      isNew: isNew, 
                      terrainImg64: terrainImg64, 
                      terrainCredit: terrainImg64 ? maprender.terrainCredit : '',
                      detailPath: detailPath,
                    };
                    const html = genHtml(templateData);


                    const tweet = genTweet(templateData);
                    fs.writeFileSync(argv.outputdir + '/tweets/TWEET-' + updateId + '.txt', tweet);
                    webshot(html, infoImg,
                      {
                        siteType: 'html',
                        windowSize: { width: 2048, height: 1082 },
                        shotSize: { width: 'all', height: 'all' }
                      },
                      function (err) {
                        if (err !== null) {
                          console.log(err);
                        }
                        
                        // Tweet out in acre order if congested.
                        const priority = numeral(Math.round(100000000000 - cur.DailyAcres)).format('0000000000000');

                        const img64 = fs.readFileSync(infoImg, {encoding: 'base64'});

                        const saved = {
                          text: tweet,
                          imageAltText: tweet,
                          imageBase64: img64
                        };

                        // Tell the twitter daemon we are ready to post.
                        const savedYaml = yaml.safeDump(saved);
                        fs.writeFileSync(argv.outputdir + '/postqueue/' + priority + '-TWEET-' + updateId + '.yaml', savedYaml);

                        outstanding--;

                        console.log('   # Exiting webshotSemaphore ' + updateId);
                        webshotSemaphore.leave();
                      });
                  };

                  if (perim.length > 0) {
                    maprender.renderMap(terrainMapImg, perim, 800, 800, 6, false, (terrainErr) => {
                      maprender.renderMap(detailMapImg, perim, 1024, 550, 14, true, (detailErr) => {
                        doWebshot(terrainErr ? null : terrainMapImg, detailErr ? null : detailMapImg);
                      });
                    });
                  } else {
                    console.log('>> Missing perimeter - ' + updateId);
                    doWebshot(null, null);
                  }
                } catch (err) {
                  console.log(err);
                }
              });


              //c--;
              //if (c < 0) {
              //    break;
              //}
            }
          } catch (err) {
            console.log(err);
          }

          outstanding--;
        });
      } catch (err) {
        console.log(err);
      } finally {
        // Just wait!
        console.log(' >> Repeat semaphore wait');
        const whenReady = function (again) {
          webshotSemaphore.take(function () {
            console.log(' >> Repeat semaphore acquired');
            if (outstanding < 0) {
              webshotSemaphore.leave();
              throw "Can't have negative outstanding requests";
            }
            if (outstanding == 0) {
              console.log(' >> Repeat semaphore - ready to refresh');
              webshotSemaphore.leave();
              fs.writeFileSync(argv.db, yaml.safeDump(x));
              if (argv.once) {
                process.exit();
                while(true) { }
              }
              setTimeout(function () { mainLoop(false, x); }, 1000 * periodSeq * 1);
              return;
            }
            console.log(' >> Repeat semaphore - NOT ready to refresh: ' + outstanding);
            webshotSemaphore.leave();
            setTimeout(function () { again(again); }, 1000);
          });
        };
        whenReady(whenReady);
      }
    }).catch(function (err) {
      console.log('Request error %s', err);
      setTimeout(function () { mainLoop(first, last); }, 1000 * periodSeq * 1);
    });

  }

  let persist = undefined;
  if (fs.existsSync(argv.db)) {
    persist = yaml.safeLoad(fs.readFileSync(argv.db));
  }


  console.log(`*** The fire information displayed by this app is UNOFFICIAL, FOR INFORMATION ONLY, 
  NOT SUITABLE FOR SAFETY/EMERGENCY PURPOSES, 
  and MAY BE INCORRECT OR OUT-OF-DATE. USE AT YOUR OWN RISK. ***`)

  setImmediate(function () { mainLoop(persist ? false : true, persist ? persist : {}); });
};
