'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');

function isDevMode() {
  return process.env.NODE_ENV !== 'production';
}

function normalizeRelPath(relPath) {
  return String(relPath || '')
    .replace(/^\/+/, '')
    .replace(/^static\//, '');
}

function assetVersion(absPath) {
  if (isDevMode()) return String(Date.now());
  try {
    return String(Math.trunc(fs.statSync(absPath).mtimeMs));
  } catch (e) {
    return '0';
  }
}

function assetUrl(relPath) {
  const clean = normalizeRelPath(relPath);
  const abs = path.join(PUBLIC_DIR, clean);
  return '/static/' + clean + '?v=' + encodeURIComponent(assetVersion(abs));
}

const asset_url = assetUrl;

function cssTag(relPath) {
  return '<link rel="stylesheet" href="' + assetUrl(relPath) + '">';
}

function jsTag(relPath, extraAttrs) {
  const extra = extraAttrs ? ' ' + extraAttrs : '';
  return '<script src="' + assetUrl(relPath) + '"' + extra + '></script>';
}

function attachAssetLocals(req, res, next) {
  res.locals.asset_url = assetUrl;
  res.locals.assetUrl = assetUrl;
  res.locals.cssTag = cssTag;
  res.locals.jsTag = jsTag;
  next();
}

module.exports = {
  assetUrl,
  asset_url,
  cssTag,
  jsTag,
  attachAssetLocals,
  isDevMode,
  PUBLIC_DIR
};
