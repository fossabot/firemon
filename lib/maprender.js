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

const StaticMaps = require('staticmaps');

const errors = require('request-promise/errors');

const envconfig = require('../envconfig');

exports.terrainCredit = 'Map tiles by\u00A0Stamen\u00A0Design\u00A0(stamen.com), under CC\u00A0BY\u00A03.0 (creativecommons.org/licenses/by/3.0). Map\u00A0data\u00A0©\u00A0OpenStreetMap contributors\u00A0(openstreetmap.org/copyright).';
exports.detailedCredit = 'Map\u00A0data\u00A0©\u00A0OpenStreetMap contributors\u00A0(openstreetmap.org/copyright).';

const tileServers = {
  osm: {
    url: 'http://tile.openstreetmap.org/{z}/{x}/{y}.png',
    size: 256,
  },
  toner: {
    url: 'http://d.tile.stamen.com/toner/{z}/{x}/{y}@2x.png',
    size: 512,
  },
  osmFrHot: {
    url: 'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    size: 256,
  },
  tfLandscape: {
    url: 'https://tile.thunderforest.com/landscape/{z}/{x}/{y}@2x.png?apikey=<APIKEY>',
    size: 512,
  },
  opentopomap: {
    url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    size: 256,
  },
  usgsTopo: {
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    size: 256,
  }
};

const renderMap = function(path, perims, width, height, maxZoom, detail, callback) {

  const det = tileServers[detail ? 'osm' : 'toner'];

  const stdOptions = {
    width: width,
    height: height,
    paddingX: detail ? 16 : 128,
    paddingY: detail ? 16 : 128,
    tileUrl: det.url,
    tileSize: det.size,
    imageMagick: envconfig.gfx.use_im ? true : false,
    sharp: envconfig.gfx.use_im ? false : true,
  };
  const map = new StaticMaps(stdOptions);

  perims.map((x) => {
    const perim = {
      coords: x,
      color: '#FF0000AA',
      fill: '#00000000',
      width: 3
    };
    map.addPolygon(perim);
  });

  const zoom = maxZoom ? Math.min(maxZoom, map.calculateZoom()) : map.calculateZoom();

  const bounds = map.determineExtent(zoom);
  const center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];

  if (!detail) {
    map.lines = [];
  
    const marker = {
      img: `${__dirname}/../imgs/xmark.png`, // can also be a URL
      offsetX: 32,
      offsetY: 32,
      width: 64,
      height: 64,
      coord: center,
    };
    map.addMarker(marker);
  }

  map.render(center, zoom)
    .then(() => {
      map.image.save(path);
    })
    .then(() => { 
      console.log('  - Perimeter generated at ' + path);
    })
    .then(() => { 
      callback(center, zoom, null); 
    })
    .catch((err) => {
      console.log(JSON.stringify(err));
      callback(center, zoom, err);
    });

};

exports.renderMap = renderMap;
