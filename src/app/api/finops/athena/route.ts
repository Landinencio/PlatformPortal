import { NextRequest, NextResponse } from "next/server";

const LAMBDA_URL = "https://jzcrsycqa2plblvxdeck37r6am0kxeqw.lambda-url.eu-north-1.on.aws/";

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const accountIds = searchParams.get("accountIds") || "all";
        const startDate = searchParams.get("startDate");
        const endDate = searchParams.get("endDate");
        const includeTrends = searchParams.get("includeTrends") !== "false";

        if (!startDate || !endDate) {
            return NextResponse.json(
                { error: "startDate and endDate are required" },
                { status: 400 }
            );
        }

        // Call Lambda
        const lambdaResponse = await fetch(LAMBDA_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                query: {
                    accountIds,
                    startDate,
                    endDate,
                    includeTrends,
                },
            }),
        });

        if (!lambdaResponse.ok) {
            throw new Error(`Lambda returned ${lambdaResponse.status}`);
        }

        const data = await lambdaResponse.json();

        // Lambda returns {statusCode, body}, we need to parse body
        if (data.body) {
            const parsedBody = typeof data.body === 'string' ? JSON.parse(data.body) : data.body;
            return NextResponse.json(parsedBody);
        }

        return NextResponse.json(data);
    } catch (error) {
        console.error("Error calling Lambda:", error);
        return NextResponse.json(
            { error: "Failed to fetch data from Lambda" },
            { status: 500 }
        );
    }
}
