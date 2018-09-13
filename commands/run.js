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


  const webshotSemaphore = require('semaphore')(1);

  const webApp = express();

  const mkdirp = require('mkdirp');

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

  const dateString = function (d) {
    return new Date(d).toISOString().substr(0, 16) + 'Z';
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


  const htmlTemplate = pug.compileFile('fireUpdate.pug');
  const genHtml = function (entry) {
    return htmlTemplate({ config: config, data: entry, curdir: process.cwd() });
  };

  const tweetTemplate = pug.compileFile('tweet.pug');

  const genTweet = function (entry) {
    return tweetTemplate({ config: config, data: entry, curdir: process.cwd() });
  };

  if (argv.twitter) {
    // Posts messages to Twitter.
    const twitterDaemon = function(path) {
      const twit = require('twit');

      const twitterAccount = new twit({
        consumer_key:         envconfig.twitterAuth.consumer_key,
        consumer_secret:      envconfig.twitterAuth.consumer_secret,
        access_token:         envconfig.twitterAuth.access_token,
        access_token_secret:  envconfig.twitterAuth.access_token_secret,
        timeout_ms:           60*1000,
        strictSSL:            true,
      });

      const postLoop = function() {
        fs.readdir(path, function(err, items) {
            if (items.length > 0) {
              console.log('@@ Found %d Twitter posts in queue', items.length);
              const p = path + items[0];
              const y = fs.readFileSync(p);
              const item = yaml.safeLoad(y);
              if (item.imageBase64) {
                twitterAccount.post('media/upload', {media_data: item.imageBase64}, function(err, data, resp) {
                  if (err) {
                    console.log(' !!! Could not upload image from ' + p);
                    console.log(err);
                    setTimeout(postLoop, 5300);
                  } else {
                    const mediaId = data.media_id_string;
                    // For accessibility.
                    const altText = item.imageAltText;
                    const metadata = { media_id: mediaId, alt_text: { text: altText } };

                    twitterAccount.post('media/metadata/create', metadata, function (err, data, resp) {
                      if (err) {
                        console.log(' !!! Could not update image metadata from ' + p);
                        console.log(err);
                        setTimeout(postLoop, 5300);
                      } else {
                        const newPost = { status: item.text, media_ids: [mediaId] };
                        twitterAccount.post('statuses/update', newPost, function (err, data, resp) {
                          if (err) {
                            console.log(' !!! Could not post tweet from ' + p);
                            console.log(err);
                            setTimeout(postLoop, 5300);
                          } else {
                            console.log(' @@ Posted new tweet - https://twitter.com/' + config.twitterName + '/status/' + data.id_str);
                            fs.unlinkSync(p);
                            setTimeout(postLoop, 67500);
                          }
                        })
                      }
                    })
                  }
                });
              }
            } else {
              setTimeout(postLoop, 5300);
            }
        });
      };
      setTimeout(postLoop, 1000);
    };

    setTimeout(() => twitterDaemon(argv.outputdir + '/postqueue/'), 1000);

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
          const bs = ['2018-COPSF-001278', '2018-NVHTF-020194', '2018-ORMED-000395', '2018-AKUYD-000356', '2018-AKUYD-000370'];
          for (var bsi in bs) {
            const bsk = bs[bsi];
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

        for (var i in x) {
          if (first) {
            continue;
          }
          const cur = x[i];
          if (i in last && last[i].ModifiedOnDateTime == cur.ModifiedOnDateTime) {
            continue;
          }

          const updateId = 'Update-' + i + '-at-' + cur.ModifiedOnDateTime + ' named ' + cur.Name;

          const old = last[i] || {};

          let oneDiff = deepDiff(old, cur);
          oneDiff = _.keyBy(oneDiff, o => o.path.join('.'));

          if (!('DailyAcres' in oneDiff || 'PercentContained' in oneDiff)) {
            // Unless acreage or containment change, we don't report it.
            continue;
          }


          const diffs = yaml.safeDump(oneDiff || []);

          console.log('- ' + updateId);

          fs.writeFileSync(argv.outputdir + '/data/DIFF-' + updateId + '.yaml', diffs);

          const templateData = { current: cur, last: old, diff: oneDiff, isNew: !(i in last) };
          const html = genHtml(templateData);

          const tweet = genTweet(templateData);
          fs.writeFileSync(argv.outputdir + '/tweets/TWEET-' + updateId + '.txt', tweet);

          console.log('   # Before webshotSemaphore ' + updateId);
          outstanding++;
          webshotSemaphore.take(function () {
            try {
              console.log('   # Entering webshotSemaphore ' + updateId);
              webshot(html, argv.outputdir + '/img/IMG-' + updateId + '.png',
                {
                  siteType: 'html',
                  windowSize: { width: 2048, height: 1082 },
                  shotSize: { width: 'all', height: 'all' }
                },
                function (err) {
                  if (err !== null) {
                    console.log(err);
                  }
                  console.log('   # Exiting webshotSemaphore ' + updateId);

                  // Tweet out in acre order if congested.
                  const priority = numeral(Math.round(100000000000 - cur.DailyAcres)).format('0000000000000');

                  const img64 = fs.readFileSync(argv.outputdir + '/img/IMG-' + updateId + '.png', {encoding: 'base64'});

                  const saved = {
                    text: tweet,
                    imageAltText: tweet,
                    imageBase64: img64
                  };

                  // Tell the twitter daemon we are ready to post.
                  const savedYaml = yaml.safeDump(saved);
                  fs.writeFileSync(argv.outputdir + '/postqueue/' + priority + '-TWEET-' + updateId + '.yaml', savedYaml);

                  outstanding--;
                  webshotSemaphore.leave();
                });
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
