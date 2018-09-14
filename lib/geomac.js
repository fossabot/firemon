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

const dateString = require('./util').dateString;
const envconfig = require('../envconfig');

const processFire = function (e) {
  let ret = {geometry: e.geometry, attributes: {}};
  const entry = e.attributes;
  for (var key in entry) {
    ret.attributes[key] = entry[key];
    if (key.endsWith('datetime')) {
      ret.attributes[key] = dateString(ret.attributes[key]);
    }
    if (_.isString(ret.attributes[key])) {
      ret.attributes[key] = ret.attributes[key].trim();
    }
  }
  return ret;
};

const qs = {
  outFields:'*',
  returnGeometry: true,
  outSR:'{"wkid": 4326}',  // WGS 84, aka lat-long
  f:'json',
  /*
  where: '',
  objectIds: '',
  time: '',
  geometry: '',
  geometryType:'esriGeometryEnvelope',
  inSR: '',
  spatialRel:'esriSpatialRelIntersects',
  distance: '',
  units:'esriSRUnit_Foot',
  relationParam: '',
  maxAllowableOffset: '',
  geometryPrecision: '',
  gdbVersion: '',
  historicMoment: '',
  returnDistinctValues;'false',
  returnIdsOnly;'false',
  returnCountOnly;'false',
  returnExtentOnly;'false',
  orderByFields: '',
  groupByFieldsForStatistics: '',
  outStatistics: '',
  returnZ;'false',
  returnM;'false',
  multipatchOption: '',
  resultOffset: '',
  resultRecordCount: '',
  returnTrueCurves;'false',
  sqlFormat:'none',*/
};

const dataOptions = {
  uri: 'https://wildfire.cr.usgs.gov/arcgis/rest/services/geomac_fires/FeatureServer/2/query',
  qs: qs,
  headers: {
    'User-Agent': 'Request-Promise'
  },
  json: true
};

/*
// EXAMPLE:
features": [
  {
   "attributes": {
    "objectid": 9975,
    "agency": "C&L",
    "comments": " ",
    "active": "Y",
    "mapmethod": "Infrared Image",
    "datecurrent": 1532995200000,
    "uniquefireidentifier": "2018-COEAX-000215",
    "fireyear": 2018,
    "incidentname": "Lake Christine",
    "pooownerunit": "COEAX",
    "perimeterdatetime": 1532948160000,
    "gisacres": 12589.173714299999,
    "complexname": " ",
    "firecode": "LX5W",
    "complexparentirwinid": " ",
    "pooresponsibleunit": "COEAX",
    "state": "CO",
    "inciwebid": "5895",
    "localincidentidentifier": "000215",
    "irwinid": "{50EAB58C-C58C-4A7D-9ED9-55B76D2EDFA7}",
    "incomplex": "N",
    "complexfirecode": " ",
    "mergeid": " ",
    "latest": "Y"
   },
   "geometry": {
    "rings": [
     [
      [
       -107.02172183285401,
       39.467937191819615
      ],
      [
       -107.02177924744112,
       39.46786103763894
      ],
      [
       -107.02178341410662,
       39.467843292844663
      ],
      */

exports.getPerimeters = function(callback) {
  rp(dataOptions).then(function (resp) {
    try {
      const data = resp.features;
      x = _.keyBy(data.map(e => processFire(e)), o => o.attributes.uniquefireidentifier);
      
      callback(x, undefined);

    } catch (err) {
      callback(undefined, err);
    }
  }).catch(function (err) {
    callback(undefined, err);
  });

};
