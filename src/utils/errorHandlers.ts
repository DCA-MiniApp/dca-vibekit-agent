import type { ApiResponse } from "../types/shared.js";
import type { Response } from "express";

/**
 * Handle validation errors
 */
export function handleValidationError(error: any, res: Response): Response {
    const response: ApiResponse = {
        success: false,
        error: "Validation Error",
        message: (error as any).errors
            .map((e: any) => `${e.path.join(".")}: ${e.message}`)
            .join(", "),
    };
    return res.status(400).json(response);
}

/**
 * Handle generic errors
 */
export function handleGenericError(
    error: any,
    res: Response,
    message: string = "An error occurred"
): Response {
    console.error(message, error);

    if (error instanceof Error && error.name === "ZodError") {
        return handleValidationError(error, res);
    }

    const response: ApiResponse = {
        success: false,
        error: "Internal Server Error",
        message,
    };
    return res.status(500).json(response);
}

/**
 * Send invalid address error
 */
export function sendInvalidAddressError(res: Response): Response {
    const response: ApiResponse = {
        success: false,
        error: "Invalid Address",
        message: "Invalid Ethereum address format",
    };
    return res.status(400).json(response);
}

/**
 * Send not found error
 */
export function sendNotFoundError(
    res: Response,
    message: string = "Resource not found"
): Response {
    const response: ApiResponse = {
        success: false,
        error: "Not Found",
        message,
    };
    return res.status(404).json(response);
}
