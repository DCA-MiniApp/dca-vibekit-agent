# BullMQ Queue Architecture & How It Works

## 🏗️ Behind the Scenes: How BullMQ Manages Jobs

### 1. **Redis Data Structures Used**

BullMQ uses Redis to store jobs in different states:

```
Redis Keys:
├── bull:notifications:wait    → List of jobs waiting to be processed
├── bull:notifications:active  → Set of jobs currently being processed
├── bull:notifications:completed → List of successfully completed jobs (limited to 1000)
├── bull:notifications:failed    → List of failed jobs (limited to 1000)
├── bull:notifications:delayed   → Sorted set of jobs scheduled for future execution
└── bull:notifications:meta      → Queue metadata (counts, etc.)
```

### 2. **Job Lifecycle States**

```
┌─────────┐
│  WAIT   │ ← Job added to queue (pollFailedTasks.ts)
└────┬────┘
     │ Worker picks up job
     ↓
┌─────────┐
│ ACTIVE  │ ← Worker is processing (notificationWorker.ts)
└────┬────┘
     │
     ├─→ Success → COMPLETED → Removed after 1000 jobs
     │
     └─→ Failure → RETRY (if attempts < 5)
                  │
                  ├─→ Success → COMPLETED
                  │
                  └─→ Max retries → FAILED → Removed after 1000 jobs
```

### 3. **How It Handles Different Scenarios**

#### ✅ **Rate Limiting (429 errors)**

**Current Behavior:**
- Worker throws error → BullMQ retries with exponential backoff
- Jobs stay in queue, don't get lost
- Retry delay: 5s, 10s, 20s, 40s, 80s (exponential)

**What Happens:**
```javascript
// Job fails with 429
throw error → BullMQ catches it
→ Job moves to "delayed" state
→ Waits 5 seconds (first retry)
→ Moves back to "wait" state
→ Worker picks it up again
→ If still 429, waits 10s, then 20s, etc.
```

**Problem:** No built-in rate limit detection - it just retries blindly.

#### 🌐 **Network Issues (Connection failures, timeouts)**

**Current Behavior:**
- Axios throws error → Worker catches and re-throws
- BullMQ automatically retries (up to 5 attempts)
- Jobs never lost - they stay in Redis until processed or max retries

**What Happens:**
```javascript
// Network timeout
axios.post(...) → throws "ECONNREFUSED" or "ETIMEDOUT"
→ Worker catches, logs error, re-throws
→ BullMQ moves job to "delayed" state
→ Retries after backoff delay
→ If Redis is down, jobs stay in Redis (persistent)
```

#### 📊 **Burst of Data (Many failed tasks at once)**

**Current Setup:**
- Poller runs every 3 minutes
- If 100 failed tasks found → 100 jobs added to queue instantly
- Worker processes 10 concurrently (concurrency: 10)
- Remaining 90 jobs wait in "wait" state

**What Happens:**
```
Minute 0:00 - Poller finds 100 failed tasks
  → Adds 100 jobs to Redis queue (instant, ~1-2 seconds)
  → Worker starts processing 10 at a time
  → 90 jobs wait in queue

Minute 0:10 - First 10 complete
  → Next 10 start processing
  → 80 still waiting

... continues until all processed
```

**Load on Server:**
- ✅ **Low CPU load** - Jobs are just data in Redis
- ✅ **Low memory** - Only active jobs in memory
- ⚠️ **Network load** - 10 concurrent HTTP requests to frontend
- ⚠️ **Redis load** - Minimal (Redis is very fast)

### 4. **3-Minute Polling: Load Analysis**

#### **Every 3 Minutes:**
1. **Poller runs:**
   - Makes 1 HTTP GET to `/api/dca/users/failed-tasks`
   - Processes response (usually < 1 second)
   - Adds jobs to Redis queue (very fast, < 100ms per job)

2. **Worker continuously:**
   - Polls Redis for new jobs (very efficient, uses Redis BLPOP)
   - Processes jobs as they arrive
   - No polling overhead - uses blocking operations

#### **Server Load:**
```
Every 3 minutes:
├── Poller: 1 API call (~500ms)
├── Redis: ~10-50 operations (negligible)
└── Worker: Continuous but idle when no jobs

Total CPU: < 1% (mostly idle)
Memory: ~50-100MB (Node.js + Redis connection)
Network: Only when processing jobs
```

**Verdict:** ✅ **Very low load** - Polling every 3 minutes is fine even with thousands of plans.

### 5. **Current Configuration Analysis**

```javascript
// pollFailedTasks.ts
await notificationQueue.add("sendNotification", payload, {
  attempts: 5,                    // Retry 5 times
  backoff: { 
    type: "exponential", 
    delay: 5000                    // Start with 5s delay
  },
  removeOnComplete: 1000,         // Keep last 1000 completed jobs
  removeOnFail: 1000,             // Keep last 1000 failed jobs
});

// notificationWorker.ts
const worker = new Worker("notifications", handler, {
  connection,
  concurrency: 10,                // Process 10 jobs simultaneously
});
```

**Issues & Improvements Needed:**

1. ❌ **No rate limit handling** - Will retry 429 errors 5 times, wasting resources
2. ❌ **No job prioritization** - All jobs treated equally
3. ⚠️ **Fixed concurrency** - Might be too high/low depending on frontend capacity
4. ✅ **Good retry strategy** - Exponential backoff is smart
5. ✅ **Deduplication** - Using Redis SET NX prevents duplicates

## 🔧 Recommended Improvements

### 1. **Add Rate Limit Detection**

```typescript
// In notificationWorker.ts
catch (error: any) {
  const status = error?.response?.status;
  
  // Handle rate limits specially
  if (status === 429) {
    const retryAfter = error?.response?.headers?.['retry-after'];
    const delay = retryAfter ? parseInt(retryAfter) * 1000 : 60000; // Default 1 minute
    
    // Move job to delayed state with specific delay
    await job.moveToDelayed(Date.now() + delay);
    return; // Don't throw, so it doesn't count as failure
  }
  
  throw error; // Other errors trigger normal retry
}
```

### 2. **Add Queue Monitoring**

```typescript
// Monitor queue health
notificationQueue.on('waiting', (job) => {
  console.log(`[Queue] Job ${job.id} waiting`);
});

notificationQueue.on('stalled', (jobId) => {
  console.warn(`[Queue] Job ${jobId} stalled - worker may have crashed`);
});

// Get queue metrics
setInterval(async () => {
  const [waiting, active, completed, failed] = await Promise.all([
    notificationQueue.getWaitingCount(),
    notificationQueue.getActiveCount(),
    notificationQueue.getCompletedCount(),
    notificationQueue.getFailedCount(),
  ]);
  console.log(`[Queue Stats] Waiting: ${waiting}, Active: ${active}, Completed: ${completed}, Failed: ${failed}`);
}, 60000); // Every minute
```

### 3. **Dynamic Concurrency Based on Load**

```typescript
// Adjust concurrency based on queue size
setInterval(async () => {
  const waiting = await notificationQueue.getWaitingCount();
  
  if (waiting > 50) {
    // High load - increase concurrency
    worker.concurrency = 20;
  } else if (waiting < 10) {
    // Low load - decrease concurrency
    worker.concurrency = 5;
  }
}, 30000);
```

### 4. **Add Job Timeout**

```typescript
// Prevent jobs from running forever
const worker = new Worker("notifications", handler, {
  connection,
  concurrency: 10,
  settings: {
    lockDuration: 30000,  // Job must complete in 30s or considered stalled
    maxStalledCount: 2,   // Max times a job can be stalled before failing
  },
});
```

## 📈 **Scaling Considerations**

### Current Capacity:
- **Poller:** Can handle 1000+ failed tasks per poll (limited by API response time)
- **Queue:** Can hold millions of jobs (Redis memory dependent)
- **Worker:** Processes 10 jobs/second (with 10 concurrency, ~1s per job)

### If You Have 10,000 Active Plans:
```
Every 3 minutes:
- Worst case: 10,000 failed tasks (unlikely, but possible)
- Queue adds: ~10 seconds (1000 jobs/second)
- Processing: ~1000 seconds = 16 minutes (10 jobs/second)
- Server load: Still low - just network I/O
```

### Recommendations:
1. ✅ **Current setup is fine** for < 1000 plans
2. ⚠️ **Consider multiple workers** if > 5000 plans
3. ⚠️ **Add monitoring** to track queue depth
4. ⚠️ **Consider job prioritization** for critical failures

## 🎯 **Summary**

**How BullMQ Works:**
- Uses Redis as persistent storage (jobs never lost)
- Jobs move through states: wait → active → completed/failed
- Automatic retries with exponential backoff
- Concurrent processing with configurable limits

**Handles Failures:**
- ✅ Network issues → Retries automatically
- ⚠️ Rate limits → Retries but doesn't respect Retry-After header
- ✅ Burst of data → Queues jobs, processes steadily
- ✅ Server crashes → Jobs persist in Redis, resume on restart

**3-Minute Polling Load:**
- ✅ **Very low** - Just 1 API call every 3 minutes
- ✅ **Worker is efficient** - Uses blocking Redis operations
- ✅ **Scales well** - Can handle thousands of plans

**Potential Issues:**
- Rate limits not handled optimally
- No queue monitoring/metrics
- Fixed concurrency might not be optimal

