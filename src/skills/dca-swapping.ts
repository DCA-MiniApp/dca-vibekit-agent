import { defineSkill } from 'arbitrum-vibekit-core';
import { z } from 'zod';
import {
  createDCAPlanTool,
  getUserDCAPlans,
  updateDCAPlanStatus,
  getPlatformStats,
} from '../tools/dcaPlans.js';
import { prepareDCASwapTool } from '../tools/prepareDCASwap.js';

console.log('🔥🔥🔥 [SKILL] Loading DCA Swapping skill...');
console.log('🔥🔥🔥 [SKILL] Available tools:', [
  createDCAPlanTool.name,
  getUserDCAPlans.name,
  updateDCAPlanStatus.name,
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
  description: 'Automated Dollar Cost Averaging (DCA) investment strategies with natural language processing. Prepare DCA swap transactions for TriggerX automated execution. Create, manage, and monitor DCA plans using simple conversational commands.',
  tags: ['dca', 'automation', 'investment', 'crypto', 'natural-language', 'triggerx'],
  examples: [
    'PREPARE a swap tx for 100 USDC to WETH',
    'Set up automated DCA investment of 50 USDC to ARB weekly for 3 months',
    'Prepare a swap tx for 100 USDC to WETH',
    'Automate my weekly ETH purchases with 25 USDC',
    'Prepare transactions for DCA plan execution',
    'Create a DCA plan record in database for 100 USDC to WETH',
    'Show me my active DCA plans and their performance',
    'Pause my USDC to ETH DCA plan',
    'How is my DCA strategy performing this month?',
    'Cancel my DAI to BTC investment plan',
    'Resume my weekly ETH purchases',
    'What are the platform statistics?',
    'Check my DCA execution history via TriggerX',
    'Add a new investment plan to my portfolio',
  ],
  inputSchema: DCASwappingInputSchema,
  tools: [
    prepareDCASwapTool, // FIRST PRIORITY: DCA swap preparation for TriggerX execution
    createDCAPlanTool, // Database record creation only
    getUserDCAPlans,
    updateDCAPlanStatus,
    getPlatformStats,
  ],
});
