import { Router } from 'express';
import type { ApiResponse } from '../../types/shared.js';
import { establishSSEConnection, waitForSSEResponseWithReader } from '../utils/sse.js';

export const prepareSwapRouter: Router = Router();

// Prepare DCA Swap Transaction API (following exact frontend pattern)
prepareSwapRouter.post('/prepare-swap', async (req, res) => {
  try {
    const { planId, planDetails, fromToken, toToken, amount, userAddress, slippage } = req.body;

    let instruction: string;
    let requestUserAddress: string;

    if (planDetails) {
      instruction = `PREPARE a swap plan to invest ${planDetails.amount} ${planDetails.fromToken} into ${planDetails.toToken}`;
      requestUserAddress = planDetails.userAddress;
    } else {
      instruction = `PREPARE a swap plan to invest ${amount} ${fromToken} into ${toToken}`;
      requestUserAddress = userAddress;
    }

    console.log(`[Prepare Swap API] Instruction: "${instruction}"`);
    console.log(`[Prepare Swap API] User: ${requestUserAddress}`);

    const requestId = Date.now() + Math.floor(Math.random() * 1000);

    // Step 1: Establish SSE connection to get session ID
    const { sessionId, reader } = await establishSSEConnection();

    // Step 2: Send request with session ID
    const requestBody = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name: 'dca-swapping',
        arguments: {
          instruction: instruction,
          userAddress: requestUserAddress
        }
      }
    };

    const response = await fetch(`http://localhost:3030/messages?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      reader.cancel().catch(() => {});
      const errorText = await response.text();
      throw new Error(`VibeKit agent responded with ${response.status}: ${errorText}`);
    }

    const initialResponse = await response.text();
    if (!initialResponse.includes('Accepted')) {
      reader.cancel().catch(() => {});
      throw new Error(`Unexpected response from agent: ${initialResponse}`);
    }

    // Step 3: Wait for SSE response
    const sseResponse = await waitForSSEResponseWithReader(requestId, reader, sessionId);

    let artifactsData: any = null;
    if (sseResponse.error) {
      throw new Error(`MCP Error: ${sseResponse.error.message || 'Unknown MCP error'}`);
    } else if (sseResponse.result && sseResponse.result.content) {
      const resourceContent = sseResponse.result.content.find((item: any) => item.type === 'resource');
      if (resourceContent?.resource?.text) {
        const taskData = JSON.parse(resourceContent.resource.text);
        if (taskData.artifacts && Array.isArray(taskData.artifacts) && taskData.artifacts.length > 0) {
          const artifact = taskData.artifacts[0];
          const textPart = artifact.parts?.find((part: any) => part.kind === 'text');
          if (textPart?.text) {
            try { artifactsData = JSON.parse(textPart.text); } catch {}
          }
        }
        if (artifactsData) {
          const apiResponse: ApiResponse = { success: true, data: artifactsData, message: 'Swap transaction prepared successfully' };
          return res.json(apiResponse);
        }
        const apiResponse: ApiResponse = { success: true, data: taskData, message: 'Swap transaction prepared successfully (raw response)' };
        return res.json(apiResponse);
      }
    }

    throw new Error('No valid response data found in SSE response');

  } catch (error) {
    console.error('[Prepare Swap API] Error:', error);
    const response: ApiResponse = {
      success: false,
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to prepare swap transaction',
    };
    res.status(500).json(response);
  }
});


