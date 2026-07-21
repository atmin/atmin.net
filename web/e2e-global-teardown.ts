import {
    DeleteBucketCommand,
    DeleteObjectsCommand,
    ListObjectsV2Command,
    S3Client,
} from '@aws-sdk/client-s3';

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

export default async function globalTeardown(): Promise<void> {
    const bucket = process.env.E2E_BUCKET;
    if (!bucket) return;

    try {
        // Delete all objects (paginated)
        let continuationToken: string | undefined;
        do {
            const list = await s3.send(
                new ListObjectsV2Command({
                    Bucket: bucket,
                    ContinuationToken: continuationToken,
                }),
            );

            if (list.Contents && list.Contents.length > 0) {
                await s3.send(
                    new DeleteObjectsCommand({
                        Bucket: bucket,
                        Delete: {
                            Objects: list.Contents.map((obj) => ({
                                Key: obj.Key,
                            })),
                            Quiet: true,
                        },
                    }),
                );
            }

            continuationToken = list.IsTruncated
                ? list.NextContinuationToken
                : undefined;
        } while (continuationToken);

        await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
        console.log(`[e2e] Deleted ephemeral bucket: ${bucket}`);
    } catch (e) {
        console.error(`[e2e] Failed to clean up bucket ${bucket}:`, e);
    }
}
