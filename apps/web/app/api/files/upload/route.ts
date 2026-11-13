import { NextResponse } from 'next/server';
import { ApiError, finalizeUpload, presignUpload } from '@/lib/api';
import { maxUploadBytes } from '@/lib/config';
import { isSameOriginRequest, tenantUrl } from '@/lib/request';
import { readSessionToken } from '@/lib/session';
import { maxFileSizeLabel } from '@/lib/format';

export const dynamic = 'force-dynamic';

async function redirect(query: string): Promise<NextResponse> {
  return NextResponse.redirect(await tenantUrl(`/files?${query}`), 303);
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginRequest(request)) return redirect('error=csrf');
  const token = await readSessionToken();
  const host = request.headers.get('x-tenant-host');
  if (!token) return NextResponse.redirect(await tenantUrl('/login'), 303);
  if (!host) return redirect('error=tenant_required');

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return redirect('error=file_required');
  if (file.size > maxUploadBytes) {
    return redirect(`error=file_too_large&max=${encodeURIComponent(maxFileSizeLabel())}`);
  }

  let presigned;
  try {
    presigned = await presignUpload(token, host, {
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 400) return redirect('error=invalid_file');
      if (error.status === 403) return redirect('error=forbidden');
      if (error.status === 503) return redirect('error=storage_unavailable');
    }
    throw error;
  }

  const uploadHeaders = new Headers();
  for (const [name, value] of Object.entries(presigned.upload.headers ?? {})) {
    // Let fetch compute the body length; a stale length breaks the signature check.
    if (name.toLowerCase() === 'content-length') continue;
    uploadHeaders.set(name, value);
  }
  if (!uploadHeaders.has('content-type')) uploadHeaders.set('content-type', file.type);

  try {
    const put = await fetch(presigned.upload.url, {
      method: 'PUT',
      headers: uploadHeaders,
      body: await file.arrayBuffer(),
      cache: 'no-store',
    });
    if (!put.ok) return redirect('error=storage_unavailable');
  } catch {
    return redirect('error=storage_unavailable');
  }

  try {
    await finalizeUpload(token, host, presigned.file.id, file.size);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 410) return redirect('error=upload_expired');
      if (error.status === 409) return redirect('error=upload_conflict');
      if (error.status === 403) return redirect('error=forbidden');
    }
    throw error;
  }

  return redirect('ok=uploaded');
}
