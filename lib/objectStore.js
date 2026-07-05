'use strict';

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const { getObjectStoreCredentials } = require('./serviceCredentials');

let client = null;
let bucket = null;

function getClient() {
  if (client) return client;

  const creds = getObjectStoreCredentials();
  if (!creds || !creds.bucket) {
    throw new Error(
      'Object Store credentials not found. Bind the "objectstore" service on CF, ' +
      'or set S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_HOST for local development.'
    );
  }

  bucket = creds.bucket;
  client = new S3Client({
    region: creds.region || 'us-east-1',
    endpoint: creds.host ? `https://${creds.host}` : undefined,
    forcePathStyle: !!creds.host,
    credentials: {
      accessKeyId: creds.access_key_id,
      secretAccessKey: creds.secret_access_key
    }
  });
  return client;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function putObject(key, body, contentType) {
  const s3 = getClient();
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType
  }));
  return key;
}

async function getObjectBuffer(key) {
  const s3 = getClient();
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return streamToBuffer(result.Body);
}

async function getObjectStream(key) {
  const s3 = getClient();
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return { stream: result.Body, contentType: result.ContentType, contentLength: result.ContentLength };
}

async function deleteObject(key) {
  const s3 = getClient();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function listObjects(prefix) {
  const s3 = getClient();
  const result = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return (result.Contents || []).map(obj => obj.Key);
}

module.exports = { putObject, getObjectBuffer, getObjectStream, deleteObject, listObjects };
