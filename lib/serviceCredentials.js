'use strict';

/**
 * Reads bound service credentials from CF's VCAP_SERVICES env var.
 * Falls back to discrete env vars for local development outside CF.
 */
function getObjectStoreCredentials() {
  const fromVcap = readVcapService('objectstore');
  if (fromVcap) return fromVcap;

  if (process.env.S3_BUCKET) {
    return {
      bucket: process.env.S3_BUCKET,
      access_key_id: process.env.S3_ACCESS_KEY_ID,
      secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
      host: process.env.S3_HOST,
      region: process.env.S3_REGION || 'us-east-1'
    };
  }

  return null;
}

function readVcapService(label) {
  if (!process.env.VCAP_SERVICES) return null;
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES);
    const instances = vcap[label];
    if (Array.isArray(instances) && instances.length > 0) {
      return instances[0].credentials;
    }
  } catch (err) {
    console.error(`[serviceCredentials] Failed to parse VCAP_SERVICES: ${err.message}`);
  }
  return null;
}

module.exports = { getObjectStoreCredentials, readVcapService };
