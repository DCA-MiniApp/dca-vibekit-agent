# DCA VibeKit Agent

A powerful **Dollar Cost Averaging (DCA) automation agent** built on the **Arbitrum VibeKit SDK** that enables users to create, manage, and execute automated cryptocurrency investment strategies through natural language commands. The agent integrates with **Ember's MCP (Model Context Protocol) tools** to get optimal swap plans and executes them securely via transaction hooks.

## 🎯 What Problem Does This Solve?

**Traditional DCA Challenges:**
- Manual execution requires constant monitoring and action
- Users often miss optimal entry points due to market timing
- Complex DeFi interfaces create barriers for average users
- No unified platform for managing multiple DCA strategies
- Lack of intelligent execution based on market conditions

**Our Solution:**
- **Automated Execution**: Set it and forget it - your DCA plans run automatically
- **Natural Language Interface**: Create strategies using simple conversational commands
- **Multi-User Support**: Handle unlimited concurrent users with individual strategies
- **Intelligent Routing**: Uses Ember's MCP tools to find optimal swap routes
- **Secure Execution**: Transaction signing through VibeKit's hook system
- **Farcaster Integration**: Accessible through Farcaster mini-apps

## 🚀 Key Features

### 🤖 **Intelligent DCA Automation**
- Create DCA plans with natural language: *"Invest 100 USDC into ETH every week for 6 months"*
- Automated execution based on your schedule
- Support for multiple tokens and strategies per user
- Flexible intervals from minutes to weeks

### 🔄 **Parallel Execution Engine**
- **Multi-user support**: Handle thousands of concurrent DCA plans
- **Batch processing**: Execute multiple swaps efficiently
- **Error isolation**: One failed plan doesn't affect others
- **Retry mechanisms**: Automatic retry with exponential backoff

### 🛡️ **Secure Transaction Handling**
- **VibeKit SDK Integration**: Leverages Arbitrum VibeKit for secure transaction preparation
- **Hook-based Execution**: Transactions are prepared and signed through VibeKit's hook system
- **User Approval Flow**: Users maintain control over their funds
- **Slippage Protection**: Configurable slippage tolerance for each plan

### 📊 **Comprehensive Management**
- Real-time plan monitoring and status updates
- Execution history and performance tracking
- Platform statistics and analytics
- Pause, resume, or cancel plans anytime

## 🏗️ Architecture

### **VibeKit SDK Integration**
The agent leverages the **Arbitrum VibeKit SDK** for:
- **MCP Tool Integration**: Connects to Ember's MCP server for optimal swap routing
- **Transaction Preparation**: Uses VibeKit's tools to prepare secure transactions
- **Hook System**: Implements transaction validation and signing hooks
- **Context Management**: Maintains user state and token information

### **Core Components**

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Farcaster     │    │   DCA Agent      │    │   VibeKit SDK   │
│   Mini App      │◄──►│   (MCP Server)   │◄──►│   + Hooks       │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │   Ember MCP      │
                       │   (Swap Plans)   │
                       └──────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │   Arbitrum       │
                       │   Blockchain     │
                       └──────────────────┘
```

### **MCP Tool Integration**
- **`getTokens`**: Fetches supported tokens across multiple chains
- **`swapTokens`**: Gets optimal swap plans with routing and pricing
- **Retry Logic**: Built-in resilience for network failures
- **Token Mapping**: Maintains comprehensive token information

## 🎮 Usage Examples

### **Creating DCA Plans**
```
"Create a DCA plan to invest 100 USDC into ETH every week for 6 months"
"Invest 0.1 WETH daily in ARB tokens for 1 month"
"Set up a conservative strategy with 50 USDC weekly into BTC for 3 months"
```

### **Managing Plans**
```
"Show me my active DCA plans and their performance"
"Pause my USDC to ETH DCA plan"
"Resume my weekly ETH purchases"
"Cancel my DAI to BTC investment plan"
```

### **Monitoring & Analytics**
```
"How is my DCA strategy performing this month?"
"Check my DCA execution history"
"What are the platform statistics?"
```

## 🔧 Technical Implementation

### **Parallel Execution System**
- **Database-driven polling**: Checks for due plans every 60 seconds
- **Batch processing**: Handles up to 50 concurrent executions
- **Error isolation**: Each plan executes independently
- **Comprehensive logging**: Full audit trail of all operations

### **Transaction Flow**
1. **Plan Creation**: User creates DCA plan via natural language
2. **Scheduling**: Plan is scheduled in database with next execution time
3. **Execution**: Scheduler triggers execution when due
4. **Swap Planning**: Ember MCP provides optimal swap route
5. **Transaction Prep**: VibeKit prepares secure transaction
6. **User Approval**: User signs transaction via hooks
7. **Execution**: Transaction is broadcast to Arbitrum
8. **Recording**: Results are stored in database

### **Security Features**
- **User-controlled funds**: Users must approve each transaction
- **Slippage protection**: Configurable tolerance per plan
- **Retry mechanisms**: Handles network failures gracefully
- **Error logging**: Comprehensive error tracking and reporting

## 🚀 Getting Started

### **Prerequisites**
- Node.js 18+ 
- PostgreSQL database
- Arbitrum RPC endpoint
- Private key for transaction execution

### **Environment Setup**
```bash
# Clone the repository
git clone <repository-url>
cd dca-vibekit-agent

# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env
# Configure your .env file with required variables

# Set up database
pnpm db:push

# Start the agent
pnpm dev
```

### **Required Environment Variables**
```env

Provide the following variables in `.env`. Use safe placeholders and never commit real secrets.

- DATABASE_URL - PostgreSQL connection string (e.g. `postgresql://user:pass@host/db?sslmode=require`)
- ARBITRUM_RPC_URL - Arbitrum RPC endpoint URL
- PRIVATE_KEY - Private key for custodial execution (development only; keep secure, do not commit)
- EMBER_MCP_SERVER_URL - Ember MCP server base URL (e.g. `https://api.emberai.xyz/mcp`)
- PORT - HTTP server port (default: 3001)
- CORS_ORIGIN - Allowed frontend origin
- ENABLE_SCHEDULER - `true`/`false` to enable the scheduler
- SCHEDULER_INTERVAL_SECONDS - Scheduler poll interval (seconds, default 60)
- MAX_CONCURRENT_EXECUTIONS - Max concurrent DCA executions
- AI_PROVIDER / OPENROUTER_API_KEY / OPENAI_API_KEY - Optional AI provider settings used by skills
- NODE_ENV - `development` or `production`

Notes

- Keep secrets out of Git. Use a secrets manager for production.
- The `.env` in the repo is an example and must be sanitized before sharing.

## Usage examples (natural language)

- "Create a DCA plan to invest 100 USDC into ETH every week for 6 months"
- "Invest 0.1 WETH daily in ARB tokens for 1 month"
- "Show me my active DCA plans"
- "Pause my USDC to ETH DCA plan"

## Developer notes

- Main entrypoint: `src/index.ts`
- Scheduler and execution logic live under `services/` and `skills/`
- MCP integrations are in `local-deps/arbitrum-vibekit-core` and the `EMBER_MCP_SERVER_URL` config
- Add global error handlers and ensure `dotenv.config()` is called early so `.env` variables are available

## Troubleshooting

- If `pnpm dev` starts and immediately exits, check `src/index.ts` for missing `app.listen(...)` or early process termination.
- Enable verbose logging via `DEBUG=true` (or set in `.env`) and restart.
- Confirm `DATABASE_URL` is correct and database migrations/push succeeded.

## Contributing

- Open issues and PRs against this repository. Follow the code style and add tests for new behavior.

## License

MIT
