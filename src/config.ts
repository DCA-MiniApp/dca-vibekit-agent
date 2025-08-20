import type { AgentConfig } from 'arbitrum-vibekit-core';
import { dcaSwappingSkill } from './skills/dca-swapping.js';

export const agentConfig: AgentConfig = {
  name: process.env.AGENT_NAME || 'DCA Agent',
  version: process.env.AGENT_VERSION || '1.0.0',
  description:
    process.env.AGENT_DESCRIPTION ||
    'Multi-user DCA automation platform supporting automated cryptocurrency investments with PostgreSQL persistence and Arbitrum Vibekit integration',
  skills: [
    dcaSwappingSkill,
  ],
  url: process.env.AGENT_URL || 'localhost',
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
};
