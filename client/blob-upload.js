// Bundled into public/vendor/blob-upload.js by `npm run bundle`.
// The upload page sends files straight to Blob storage, in one go or in parts.
import { put, createMultipartUpload, uploadPart, completeMultipartUpload } from '@vercel/blob/client';

window.blobClient = { put, createMultipartUpload, uploadPart, completeMultipartUpload };
