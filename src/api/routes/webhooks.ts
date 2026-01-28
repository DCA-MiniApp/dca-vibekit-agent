import { Router } from "express";

const router: Router = Router();

// In-memory store for recent webhook updates (last 50)
const webhooksLog: any[] = [];

/**
 * Shiprocket Webhook Endpoint
 * Handles order updates from Shiprocket
 * 
 * Expected Header: x-api-key
 * Expected Method: POST
 */
router.post("/shipping-catch", async (req, res) => {
    try {
        const incomingKey = req.headers["x-api-key"];
        const serverKey = process.env.SHIPROCKET_WEBHOOK_TOKEN;

        // Validate API Key
        if (!incomingKey || incomingKey !== serverKey) {
            console.warn(`[Shiprocket Webhook] Unauthorized access attempt with key: ${incomingKey}`);
            return res.status(401).json({
                success: false,
                message: "Unauthorized: Invalid API key",
            });
        }

        const payload = req.body;
        const timestamp = new Date().toISOString();

        // Log the received update
        console.log(`📦 [Shiprocket Webhook] Received Update at ${timestamp}:`);
        console.log(JSON.stringify(payload, null, 2));

        // Store in memory log
        webhooksLog.unshift({
            timestamp,
            payload
        });

        // Keep only last 50 entries
        if (webhooksLog.length > 50) {
            webhooksLog.pop();
        }

        // Extract some key details for a quick summary in logs
        const { order_id, shipment_status, awb, current_status } = payload;
        console.log(`[Shiprocket Webhook] Order ID: ${order_id}, Status: ${shipment_status || current_status}, AWB: ${awb}`);

        // Respond to Shiprocket to acknowledge receipt
        res.status(200).json({
            success: true,
            message: "Webhook received successfully",
        });
    } catch (error) {
        console.error("❌ [Shiprocket Webhook] Error processing webhook:", error);
        res.status(500).json({
            success: false,
            message: "Internal Server Error",
        });
    }
});

/**
 * GET endpoint to view recent Shiprocket updates
 * Useful for debugging or showing updates in a UI
 */
router.get("/shiprocket/logs", (req, res) => {
    res.json({
        success: true,
        count: webhooksLog.length,
        data: webhooksLog
    });
});

export { router as webhookRoutes };
