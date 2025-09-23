export async function establishSSEConnection(): Promise<{
  sessionId: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  response: Response;
}> {
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('SSE connection timeout after 30 seconds'));
    }, 30000);

    let sseResponse: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      console.log('[SSE] Opening SSE connection...');
      sseResponse = await fetch(`http://localhost:3030/sse`, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });

      if (!sseResponse.ok) {
        clearTimeout(timeout);
        reject(new Error(`SSE connection failed: ${sseResponse.status}`));
        return;
      }

      reader = sseResponse.body?.getReader();
      if (!reader) {
        clearTimeout(timeout);
        reject(new Error('Failed to get SSE stream reader'));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let sessionId: string | null = null;

      try {
        while (!sessionId) {
          const { done, value } = await reader.read();
          if (done) {
            clearTimeout(timeout);
            reject(new Error('SSE stream ended before getting session ID'));
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            // Handle session ID from endpoint data
            if (line.startsWith('data: /messages?sessionId=')) {
              const sessionIdPart = line.split('sessionId=')[1];
              if (!sessionIdPart) {
                clearTimeout(timeout);
                reject(new Error('Malformed session ID line in SSE stream'));
                return;
              }
              sessionId = sessionIdPart.trim();
              console.log('[SSE] Session established:', sessionId);
              clearTimeout(timeout);
              resolve({ sessionId, reader, response: sseResponse });
              return;
            }
          }
        }
      } catch (error) {
        clearTimeout(timeout);
        reader.cancel().catch(() => {});
        reject(error);
      }
    } catch (error) {
      clearTimeout(timeout);
      if (reader) {
        reader.cancel().catch(() => {});
      }
      reject(error);
    }
  });
}

export async function waitForSSEResponseWithReader(
  requestId: number,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sessionId: string
): Promise<any> {
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('SSE response timeout after 60 seconds'));
    }, 60000);

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timeout);
          reject(new Error('SSE stream ended without finding response'));
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line.includes(`"id":${requestId}`)) {
            try {
              const jsonStr = line.substring(6);
              const responseData = JSON.parse(jsonStr);
              clearTimeout(timeout);
              reader.cancel().catch(() => {});
              resolve(responseData);
              return;
            } catch (parseError) {
              console.warn('[SSE] Failed to parse response line:', line);
            }
          }
        }
      }
    } catch (error) {
      clearTimeout(timeout);
      reader.cancel().catch(() => {});
      reject(error);
    }
  });
}


