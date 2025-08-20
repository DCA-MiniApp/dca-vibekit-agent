import { Router } from 'express';
import { ManualSwapSchema, type ApiResponse } from '../../types/shared.js';

const router: Router = Router();

// Manual swap execution (will be implemented in Phase 5)
router.post('/execute', async (req, res) => {
  try {
    // Validate request body
    const validatedData = ManualSwapSchema.parse(req.body);
    
    // TODO: Implement manual swap execution in Phase 5
    // This will use the swap tools and MCP integration
    
    console.log(`📝 Manual swap request: ${validatedData.amount} ${validatedData.fromToken} → ${validatedData.toToken}`);
    
    const response: ApiResponse = {
      success: false,
      error: 'Not Implemented',
      message: 'Manual swap execution will be implemented in Phase 5 - Automation & Scheduling',
    };
    
    res.status(501).json(response);
    
  } catch (error) {
    console.error('Error processing swap request:', error);
    
    if (error instanceof Error && error.name === 'ZodError') {
      const response: ApiResponse = {
        success: false,
        error: 'Validation Error',
        message: (error as any).errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', '),
      };
      return res.status(400).json(response);
    }
    
    const response: ApiResponse = {
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to process swap request',
    };
    res.status(500).json(response);
  }
});

// Get supported tokens (static list for now)
router.get('/tokens', (req, res) => {
  const supportedTokens = {
    WETH: {
      symbol: 'WETH',
      name: 'Wrapped Ether',
      address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      decimals: 18,
    },
    USDC: {
      symbol: 'USDC',
      name: 'USD Coin',
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      decimals: 6,
    },
    USDT: {
      symbol: 'USDT',
      name: 'Tether USD',
      address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      decimals: 6,
    },
    ARB: {
      symbol: 'ARB',
      name: 'Arbitrum',
      address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
      decimals: 18,
    },
    DAI: {
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
      decimals: 18,
    },
  };
  
  const response: ApiResponse = {
    success: true,
    data: supportedTokens,
    message: 'Supported tokens on Arbitrum',
  };
  
  res.json(response);
});

export { router as swapRoutes };
