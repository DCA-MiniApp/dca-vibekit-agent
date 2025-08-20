import type { SkillDefinition } from 'arbitrum-vibekit-core';
import { z } from 'zod';
import {
  createDCAPlanTool,
  getUserDCAPlans,
  updateDCAPlanStatus,
  getDCAExecutionHistory,
  getPlatformStats,
} from '../tools/dcaPlans.js';
import { executeDCASwapTool } from '../tools/executeDCASwap.js';

export const dcaSwappingSkill: SkillDefinition<z.ZodObject<{}>> = {
  id: 'dca-swapping',
  name: 'DCA Swapping',
  description: 'Automated Dollar Cost Averaging (DCA) swapping for multiple users with PostgreSQL persistence',
  tags: ['dca', 'automation', 'investment', 'crypto'],
  examples: [
    'Create a DCA plan to invest 100 USDC into ETH every week for 6 months',
    'Show me my active DCA plans',
    'Pause my USDC to ETH DCA plan',
    'How is my DCA strategy performing?',
    'Invest 0.1 WETH daily in ARB tokens for 1 month',
  ],
  inputSchema: z.object({}),
  
  // Tools for DCA plan management and execution
  tools: [
    createDCAPlanTool,
    getUserDCAPlans,
    updateDCAPlanStatus,
    getDCAExecutionHistory,
    getPlatformStats,
    executeDCASwapTool, // DCA swap execution with transaction handling
  ],
};
