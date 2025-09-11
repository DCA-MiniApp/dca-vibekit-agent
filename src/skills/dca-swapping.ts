import { defineSkill } from 'arbitrum-vibekit-core';
import { z } from 'zod';
import {
  createDCAPlanTool,
  getUserDCAPlans,
  updateDCAPlanStatus,
  getDCAExecutionHistory,
  getPlatformStats,
} from '../tools/dcaPlans.js';
import { prepareDCASwapTool } from '../tools/prepareDCASwap.js';

console.log('🔥🔥🔥 [SKILL] Loading DCA Swapping skill...');
console.log('🔥🔥🔥 [SKILL] Available tools:', [
  createDCAPlanTool.name,
  getUserDCAPlans.name,
  updateDCAPlanStatus.name,
  getDCAExecutionHistory.name,
  getPlatformStats.name,
  prepareDCASwapTool.name
]);

// Input schema for the DCA swapping skill with natural language instruction
const DCASwappingInputSchema = z.object({
  instruction: z.string().describe('Natural language instruction for DCA operations - e.g., "Create a DCA plan to invest 100 USDC into ETH every week for 6 months", "Show my active DCA plans", "Pause my USDC to ETH plan"'),
  userAddress: z.string().optional().describe('User wallet address for DCA operations (optional, can be extracted from instruction)'),
});

export const dcaSwappingSkill = defineSkill({
  id: 'dca-swapping',
  name: 'DCA Swapping',
  description: 'Automated Dollar Cost Averaging (DCA) investment strategies with natural language processing. Create, manage, and monitor DCA plans using simple conversational commands.',
  tags: ['dca', 'automation', 'investment', 'crypto', 'natural-language'],
  examples: [
    'Create a DCA plan to invest 100 USDC into ETH every week for 6 months',
    'Show me my active DCA plans and their performance',
    'Pause my USDC to ETH DCA plan',
    'How is my DCA strategy performing this month?',
    'Invest 0.1 WETH daily in ARB tokens for 1 month',
    'Cancel my DAI to BTC investment plan',
    'Resume my weekly ETH purchases',
    'What are the platform statistics?',
    'Check my DCA execution history',
    'Create a conservative investment strategy with 50 USDC weekly into BTC for 3 months',
  ],
  inputSchema: DCASwappingInputSchema,
  tools: [
    createDCAPlanTool,
    getUserDCAPlans,
    updateDCAPlanStatus,
    getDCAExecutionHistory,
    getPlatformStats,
    prepareDCASwapTool, // DCA swap preparation for TriggerX execution
  ],
});
