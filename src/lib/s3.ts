import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import fs from "node:fs";
import type { Readable } from "node:stream";

let client: S3Client | null = null;

function s3() {
  client ??= new S3Client({ region: process.env.AWS_REGION || "us-east-2" });
  return client;
}

export function bucket(): string {
  const b = process.env.BACKUP_BUCKET;
  if (!b) throw new Error("BACKUP_BUCKET is not set (see .env.example)");
  return b;
}

export async function upload(key: string, file: string, sha256: string) {
  await new Upload({
    client: s3(),
    params: {
      Bucket: bucket(),
      Key: key,
      Body: fs.createReadStream(file),
      ServerSideEncryption: "AES256",
      Metadata: { sha256 },
    },
  }).done();
}

export async function getStream(key: string): Promise<Readable> {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return res.Body as Readable;
}

export function s3Uri(key: string) {
  return `s3://${bucket()}/${key}`;
}
