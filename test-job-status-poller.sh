#!/bin/bash

# Test script for DCA Job Status Poller with dummy data
# This script helps you test the Slack notification system without needing real database data

echo "🧪 Testing DCA Job Status Poller with Dummy Data"
echo "================================================"
echo ""

# Check if SLACK_WEBHOOK_URL is set
if [ -z "$SLACK_WEBHOOK_URL" ]; then
    echo "⚠️  WARNING: SLACK_WEBHOOK_URL is not set!"
    echo "   Notifications will not be sent to Slack."
    echo "   Set it in your .env file or export it:"
    echo "   export SLACK_WEBHOOK_URL='https://hooks.slack.com/services/YOUR/WEBHOOK/URL'"
    echo ""
else
    echo "✅ SLACK_WEBHOOK_URL is configured"
    echo ""
fi

# Set test mode environment variable
export JOB_STATUS_POLLER_TEST_DATA=TRUE

echo "🔧 Test mode enabled (JOB_STATUS_POLLER_TEST_DATA=TRUE)"
echo ""
echo "📊 Test Data:"
echo "   - 2 DCA plans"
echo "   - 1 job with status 'processing'"
echo "   - 2 tasks: 1 completed, 1 processing"
echo "   - Username: alice.eth"
echo ""
echo "🚀 Triggering manual poll..."
echo ""

# Trigger the manual poll endpoint
curl -X POST http://localhost:3031/api/dca/trigger-job-status-poll

echo ""
echo ""
echo "✅ Test complete!"
echo ""
echo "📝 Check your server logs for:"
echo "   [Job Status Poller] 🧪 Using TEST data"
echo "   [Job Status Poller] 🧪 Using test job data"
echo "   [Job Status Poller] 🧪 Using test username"
echo "   [Job Status Poller] ✅ Sent Slack notification"
echo ""
echo "💬 Check your Slack channel for notifications!"
echo ""
echo "🔄 To disable test mode, unset the environment variable:"
echo "   unset JOB_STATUS_POLLER_TEST_DATA"
