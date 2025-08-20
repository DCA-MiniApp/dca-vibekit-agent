/**
 * DCA Agent Tools
 * 
 * This module exports all tools available for the DCA agent.
 * Tools provide the interface between the AI agent and the REST API endpoints.
 */

export {
  createDCAPlanTool,
  getUserDCAPlans,
  updateDCAPlanStatus,
  getDCAExecutionHistory,
  getPlatformStats,
} from './dcaPlans.js';

export {
  executeDCASwapTool,
} from './executeDCASwap.js';

// Future tools (Phase 5: Automation & Scheduling)
// export { getTokenBalancesTool } from './tokenBalances.js';
