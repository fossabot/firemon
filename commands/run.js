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
  },
  clean: {
    boolean: true,
    desc: 'Whether to clear the data files and Twitter post queue before starting'
  },
  locations: {
    boolean: true,
    desc: 'Whether to post images of fire locations'
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
  const rimraf = require('rimraf');

  const envconfig = require('../envconfig');
  const dateString = require('../lib/util').dateString;
  const maprender = require('../lib/maprender');
  const geocoding = require('../lib/geocoding');
  const geomac = require('../lib/geomac');

  const FairSemaphore = require('fair-semaphore');
  const processingSemaphore = new FairSemaphore(1);

  const namedSemaphore = function(impl, name) {
    return {
      take: function(cb) {
        impl.take(name, cb);
      },
      leave: function() {
        impl.leave();
      }
    };
  };
  const intensiveProcessingSemaphore = namedSemaphore(processingSemaphore, 'computation');

  const webApp = express();

  const mkdirp = require('mkdirp');

  const tmpdir = os.tmpdir() + '/firemon/';

  if (argv.clean) {
    rimraf.sync(tmpdir, {disableGlob: true});
    rimraf.sync(argv.outputdir, {disableGlob: true});
  }

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
    for (let key in entry) {
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

  const perimeterTemplate = pug.compileFile('firePerimeterRender.pug');
  const perimeterHtml = function (entry) {
    return perimeterTemplate({ config: config, data: entry, curdir: process.cwd() });
  };

  const tweetTemplate = pug.compileFile('fireUpdateTweet.pug');

  const genTweet = function (entry) {
    return tweetTemplate({ config: config, data: entry, curdir: process.cwd() });
  };

  if (argv.twitter) {
    const t = require('../lib/twitter');
    t.launchDaemon(argv.outputdir + '/postqueue/', namedSemaphore(processingSemaphore, 'twitter'));
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

        if (REMOVE_forceDeltaDebug && !first) {
          const bs = ['2018-CASHF-001444','2018-WAOWF-000443','2018-CASHF-001438'];
          for (let bsi in bs) {
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

        const globalUpdateId = 'Update-at-' + dateString(new Date().getTime());
        {
          console.log('Writing ' + globalUpdateId);
          const diffGlobal = deepDiff(last, x) || [];
          const diffsGlobal = yaml.safeDump(diffGlobal);
          fs.writeFileSync(argv.outputdir + '/data/GLOBAL-DIFF-' + globalUpdateId + '.yaml', diffsGlobal);
        }

        outstanding++;

        intensiveProcessingSemaphore.take(() => {
          geomac.getPerimeters((perims, err) => {

            //console.log(perims);

            try {
              if (err) {
                throw err;
              }
              for (let zi in x) {
                const i = zi;
                
                if (first) {
                  continue;
                }
                const cur = x[i];


                if (i in last && last[i].ModifiedOnDateTime == cur.ModifiedOnDateTime) {
                  continue;
                }

                const old = last[i] || {};

                const updateId = 'Update-' + cur.ModifiedOnDateTime + '-of-' + i + ' named ' + cur.Name;

                let oneDiff = deepDiff(old, cur);
                oneDiff = _.keyBy(oneDiff, o => o.path.join('.'));

                if (!('DailyAcres' in oneDiff || 'PercentContained' in oneDiff)) {
                  // Unless acreage or containment change, we don't report it.
                  continue;
                }

              
                let perim = [];
                let perimDateTime = null;

                if (cur.UniqueFireIdentifier in perims) {
                  perim = perims[cur.UniqueFireIdentifier].geometry.rings || [];
                  perimDateTime = perims[cur.UniqueFireIdentifier].attributes.perimeterdatetime;
                }
                const children = _.values(perims)
                  .filter(fire => {
                    const b = (fire.attributes.complexname || '').toLowerCase() === cur.Fire_Name.toLowerCase()
                    return b;
                  })
                  .map(fire => fire.geometry.rings)
                  .reduce((a,b) => a.concat(b), []);

                perim = perim.concat(children);
                perim = perim.map(geomac.cleanGeometryRing);        

                const diffs = yaml.safeDump(oneDiff || []);
                const isNew = !(i in last);

                console.log('- ' + updateId);

                fs.writeFileSync(argv.outputdir + '/data/DIFF-' + updateId + '.yaml', diffs);

                console.log('   # Before intensiveProcessingSemaphore ' + updateId);
                outstanding++;

                intensiveProcessingSemaphore.take(function () {
                  try {
                    console.log('   # Entering intensiveProcessingSemaphore ' + updateId);
                    const infoImg = argv.outputdir + '/img/IMG-TWEET-' + updateId + '.png';
                    const perimImg = argv.outputdir + '/img/IMG-PERIM-' + updateId + '.png';
                    const terrainMapImg = tmpdir + '/img/src/terrain/MAP-TERRAIN-' + updateId + '.png';
                    const detailMapImg = tmpdir + '/img/src/detail/MAP-DETAIL-' + updateId + '.png';

                    const doWebshot = (center, zoom, terrainPath, detailPath) => {

                      const lat = center ? center[1] : null
                      const lon = center ? center[0] : null

                      const cities = geocoding.nearestCities(lat, lon, 100, 10 * 2.5 + Math.sqrt(0.00404686 /*km2 per acre*/ * cur.DailyAcres)) 
                        .map(x => {
                          x.displayName = geocoding.cityDisplayName(x);
                          return x;
                        });

                      const nearPopulation = cities.reduce((a, b) => (a + b.population), 0);
                      console.log('  > Fire %s is near pop. %d', updateId, nearPopulation);


                      const terrainImg = terrainPath || null;
                      const templateData = { 
                        cities: cities,
                        current: cur, 
                        last: old, 
                        diff: oneDiff, 
                        isNew: isNew, 
                        terrainImg: terrainImg, 
                        terrainCredit: terrainImg ? maprender.terrainCredit : '',
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

                          const saveTweet = function(detailRender) {
                            
                            // Tweet out in population and acre order.
                            const invPrio = Math.log10(cur.DailyAcres) * 1000 + nearPopulation;
                            const priority = numeral(Math.round(100000000000 - invPrio)).format('0000000000000');
                            let saved = {
                              text: tweet,
                              image1AltText: tweet,
                              image1: infoImg,
                              image2AltText: 'Perimeter map',
                              image2: detailRender,
                            };
                            if (center) {
                              saved.coords = { lat: lat, lon: lon };
                            }

                            // Tell the twitter daemon we are ready to post.
                            const savedYaml = yaml.safeDump(saved);
                            fs.writeFileSync(argv.outputdir + '/postqueue/' + priority + '-TWEET-' + updateId + '.yaml', savedYaml);

                            outstanding--;

                            console.log('   # Exiting intensiveProcessingSemaphore ' + updateId);
                            intensiveProcessingSemaphore.leave();
                          }

                          const detailImg = detailPath || null;
                          if (detailImg) {
                            const perimTemplateData = {
                              cities: cities,
                              perimDateTime: perimDateTime,
                              current: cur, 
                              last: old, 
                              diff: oneDiff, 
                              isNew: isNew, 
                              img: detailImg, 
                              imgCredit: detailImg ? maprender.detailedCredit : '',
                            };
                            const htmlPerim = perimeterHtml(perimTemplateData);
                            webshot(htmlPerim, perimImg,
                              {
                                siteType: 'html',
                                windowSize: { width: 3993, height: 2048 },
                                shotSize: { width: 'all', height: 'all' }
                              },
                              function (err) {
                                if (err !== null) {
                                  console.log(err);
                                }
                                saveTweet(err ? null : perimImg);
                              });
                          } else {
                            saveTweet(null);
                          }

                        });
                    };

                    if (perim.length > 0 && argv.locations) {
                      maprender.renderMap(terrainMapImg, perim, 800, 800, 6, false, (center, zoom, terrainErr) => {
                        maprender.renderMap(detailMapImg, perim, 2338/2, 1100/2, 13, true, (_center, _zoom, detailErr) => {
                          doWebshot(center, zoom, terrainErr ? null : terrainMapImg, detailErr ? null : detailMapImg);
                        });
                      });
                    } else {
                      console.log('>> Missing perimeter - ' + updateId);
                      doWebshot(null, null, null, null);
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
            intensiveProcessingSemaphore.leave();
          });
        });
      } catch (err) {
        console.log(err);
      } finally {
        // Just wait!
        console.log(' >> Repeat semaphore wait');
        const whenReady = function (again) {
          intensiveProcessingSemaphore.take(function () {
            console.log(' >> Repeat semaphore acquired');
            if (outstanding < 0) {
              intensiveProcessingSemaphore.leave();
              throw "Can't have negative outstanding requests";
            }
            if (outstanding == 0) {
              console.log(' >> Repeat semaphore - ready to refresh');
              intensiveProcessingSemaphore.leave();
              fs.writeFileSync(argv.db, yaml.safeDump(x));
              if (argv.once) {
                process.exit();
                while(true) { }
              }
              setTimeout(function () { mainLoop(false, x); }, 1000 * periodSeq * 1);
              return;
            }
            console.log(' >> Repeat semaphore - NOT ready to refresh: ' + outstanding);
            intensiveProcessingSemaphore.leave();
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
