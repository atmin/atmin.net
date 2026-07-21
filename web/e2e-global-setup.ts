import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
    region: 'us-east-1',
    // E2E_S3_ENDPOINT: Makefile sets it from MINIO_PORT (default :29000);
    // :9000 fallback is CI's standalone MinIO.
    endpoint: process.env.E2E_S3_ENDPOINT ?? 'http://localhost:9000',
    forcePathStyle: true,
    credentials: {
        accessKeyId: 'minioadmin',
        secretAccessKey: 'minioadmin',
    },
});

export default async function globalSetup(): Promise<void> {
    const bucket = process.env.E2E_BUCKET;
    if (!bucket) throw new Error('E2E_BUCKET not set');

    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`[e2e] Created ephemeral bucket: ${bucket}`);
}
