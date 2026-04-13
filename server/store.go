package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

var ErrNotFound = errors.New("not found")

// Store is the storage interface. S3Client implements it for production;
// MemStore implements it for tests.
type Store interface {
	GetObject(ctx context.Context, key string) ([]byte, error)
	PutObject(ctx context.Context, key string, data []byte, contentType string) error
	HeadObject(ctx context.Context, key string) error
	DeleteObject(ctx context.Context, key string) error
	DeleteObjects(ctx context.Context, keys []string) error
	ListObjects(ctx context.Context, prefix string, limit int, cursor string) (keys []string, nextCursor string, err error)
	// ListObjectSizes returns total bytes and object count under prefix, up to `limit` keys.
	// `truncated` is true if more keys exist beyond `limit` (single page).
	ListObjectSizes(ctx context.Context, prefix string, limit int) (totalBytes int64, count int, truncated bool, err error)
	PresignPut(ctx context.Context, key string, contentLength int64, ttl time.Duration) (string, error)
}

// S3Client wraps the AWS SDK S3 client.
type S3Client struct {
	client    *s3.Client
	presigner *s3.PresignClient
	bucket    string
}

func NewS3Client(ctx context.Context, cfg Config) (*S3Client, error) {
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(cfg.S3Region),
		awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.S3AccessKey, cfg.S3SecretKey, ""),
		),
	)
	if err != nil {
		return nil, err
	}

	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(cfg.S3Endpoint)
		o.UsePathStyle = true // required for MinIO
	})

	// Separate client for presigning so URLs use a browser-reachable endpoint.
	presignClient := client
	if cfg.S3PublicEndpoint != cfg.S3Endpoint {
		presignClient = s3.NewFromConfig(awsCfg, func(o *s3.Options) {
			o.BaseEndpoint = aws.String(cfg.S3PublicEndpoint)
			o.UsePathStyle = true
		})
	}

	return &S3Client{
		client:    client,
		presigner: s3.NewPresignClient(presignClient),
		bucket:    cfg.S3Bucket,
	}, nil
}

func (c *S3Client) GetObject(ctx context.Context, key string) ([]byte, error) {
	out, err := c.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: &c.bucket,
		Key:    &key,
	})
	if err != nil {
		var nsk *types.NoSuchKey
		if errors.As(err, &nsk) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	defer out.Body.Close()
	return io.ReadAll(out.Body)
}

func (c *S3Client) PutObject(ctx context.Context, key string, data []byte, contentType string) error {
	_, err := c.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      &c.bucket,
		Key:         &key,
		Body:        bytes.NewReader(data),
		ContentType: &contentType,
	})
	return err
}

func (c *S3Client) HeadObject(ctx context.Context, key string) error {
	_, err := c.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: &c.bucket,
		Key:    &key,
	})
	if err != nil {
		var nsk *types.NotFound
		if errors.As(err, &nsk) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

func (c *S3Client) DeleteObject(ctx context.Context, key string) error {
	_, err := c.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: &c.bucket,
		Key:    &key,
	})
	return err
}

func (c *S3Client) DeleteObjects(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	objects := make([]types.ObjectIdentifier, len(keys))
	for i, k := range keys {
		objects[i] = types.ObjectIdentifier{Key: aws.String(k)}
	}
	_, err := c.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
		Bucket: &c.bucket,
		Delete: &types.Delete{Objects: objects, Quiet: aws.Bool(true)},
	})
	return err
}

func (c *S3Client) ListObjects(ctx context.Context, prefix string, limit int, cursor string) ([]string, string, error) {
	input := &s3.ListObjectsV2Input{
		Bucket:  &c.bucket,
		Prefix:  &prefix,
		MaxKeys: aws.Int32(int32(limit)),
	}
	if cursor != "" {
		input.StartAfter = &cursor
	}

	out, err := c.client.ListObjectsV2(ctx, input)
	if err != nil {
		return nil, "", err
	}

	keys := make([]string, len(out.Contents))
	for i, obj := range out.Contents {
		keys[i] = *obj.Key
	}

	var nextCursor string
	if out.IsTruncated != nil && *out.IsTruncated && len(keys) > 0 {
		nextCursor = keys[len(keys)-1]
	}

	return keys, nextCursor, nil
}

func (c *S3Client) ListObjectSizes(ctx context.Context, prefix string, limit int) (int64, int, bool, error) {
	out, err := c.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket:  &c.bucket,
		Prefix:  &prefix,
		MaxKeys: aws.Int32(int32(limit)),
	})
	if err != nil {
		return 0, 0, false, err
	}
	var total int64
	for _, obj := range out.Contents {
		if obj.Size != nil {
			total += *obj.Size
		}
	}
	truncated := out.IsTruncated != nil && *out.IsTruncated
	return total, len(out.Contents), truncated, nil
}

func (c *S3Client) PresignPut(ctx context.Context, key string, contentLength int64, ttl time.Duration) (string, error) {
	req, err := c.presigner.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:        &c.bucket,
		Key:           &key,
		ContentLength: &contentLength,
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}
