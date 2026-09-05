export async function analyzeUrl(url, source = 'youtube') {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, source }),
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || 'Unable to analyze this URL.');
  }

  return data;
}

export async function requestDownload(jobId, formatId) {
  const response = await fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, formatId }),
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || 'Unable to start the download.');
  }

  return data;
}
