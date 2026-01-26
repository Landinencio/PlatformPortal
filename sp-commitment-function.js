// Add this function at the end of the file, after executeSavingsPlansQuery

async function getSavingsPlansCommitment() {
    try {
        const command = new DescribeSavingsPlansCommand({
            savingsPlanIds: ['dae0756e-c1b1-465a-a5a0-c48a1927ddb5']
        });

        const response = await savingsPlansClient.send(command);

        if (!response.savingsPlans || response.savingsPlans.length === 0) {
            return null;
        }

        const sp = response.savingsPlans[0];

        // Calculate monthly commitment based on hourly commitment
        const hourlyCommitment = parseFloat(sp.commitment || 0);
        const hoursInMonth = 730; // Average hours in a month (365.25 * 24 / 12)
        const monthlyCommitment = hourlyCommitment * hoursInMonth;

        return {
            savingsPlanId: sp.savingsPlanId,
            savingsPlanArn: sp.savingsPlanArn,
            hourlyCommitment: parseFloat(hourlyCommitment.toFixed(4)),
            monthlyCommitment: parseFloat(monthlyCommitment.toFixed(2)),
            paymentOption: sp.paymentOption,
            savingsPlanType: sp.savingsPlanType,
            startTime: sp.start,
            endTime: sp.end,
            state: sp.state,
            recurringPayment: parseFloat(sp.recurringPaymentAmount || 0),
            upfrontPayment: parseFloat(sp.upfrontPaymentAmount || 0)
        };
    } catch (error) {
        console.error('Error fetching Savings Plans commitment:', error);
        return null; // Return null if SP API fails, don't break the whole response
    }
}
