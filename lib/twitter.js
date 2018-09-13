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

const _ = require('lodash');
const yaml = require('js-yaml');
const fs = require('fs');

const envconfig = require('../envconfig');
const twit = require('twit');

// Posts messages to Twitter.
const twitterDaemon = function(path) {

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
                        console.log(' @@ Posted new tweet - https://twitter.com/' +  envconfig.twitterAuth.name + '/status/' + data.id_str);
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

exports.launchDaemon = function(dir) {
  setTimeout(() => twitterDaemon(dir), 1000);
};
