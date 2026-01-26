# Platform Portal

[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)

A self-service developer portal for Platform Engineering teams. Streamline infrastructure provisioning, repository creation, user onboarding, and AWS cost analysis—all in one beautiful interface.

## ✨ Features

### 🏗️ Infrastructure Provisioning
- **Self-Service Infrastructure**: Developers request infrastructure through forms
- **N8N Workflow Integration**: Automated provisioning workflows
- **Multi-Environment Support**: Dev, UAT, Prod configurations
- **Database & Storage**: PostgreSQL, MongoDB, S3 buckets, VPCs

### 📦 Repository Management
- **Git Repository Creation**: Create repos with templates
- **Auto-Configuration**: Branch protection, CI/CD setup
- **Team Permissions**: Automatic access control

### 👥 User Onboarding
- **Streamlined Onboarding**: New developer setup
- **Group Management**: LDAP/AD integration
- **Access Requests**: Self-service permission requests

### 💰 FinOps Analytics (⭐ Featured)
- **AWS Cost Dashboard**: Real-time cost visualization powered by Athena & CUR
- **Savings Plans Tracker**: Monitor SP coverage and calculate real savings
- **AI Cost Analysis**: DeepSeek-powered insights and recommendations
- **Account Breakdown**: Per-account and per-service cost analysis
- **Trend Analysis**: Compare periods and identify cost increases

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ and npm
- AWS Account with:
  - Athena configured
  - Cost & Usage Reports (CUR) enabled
  - Lambda execution permissions
- N8N instance (for workflows)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/platform-portal.git
cd platform-portal

# Install dependencies
npm install

# Create environment file
cp .env.example .env

# Configure your environment variables (see Configuration section)
nano .env

# Run development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the portal.

## ⚙️ Configuration

### Environment Variables

Create a `.env` file based on `.env.example`:

```env
# AWS Configuration
AWS_ACCOUNTS='[{"id":"123456789012","name":"Production"},{"id":"987654321098","name":"Development"}]'
ATHENA_DATABASE=your_cost_database
ATHENA_RESULTS_BUCKET=s3://your-bucket/athena-results/
AWS_REGION=us-east-1

# N8N Webhook
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook
N8N_WEBHOOK_TOKEN=your_webhook_token

# Application
NEXT_PUBLIC_APP_NAME="Platform Portal"
NEXT_PUBLIC_COMPANY_NAME="Your Company"

# Optional: AI Analysis
DEEPSEEK_API_KEY=your_deepseek_api_key
```

### AWS Lambda Setup (FinOps)

Deploy the included Lambda function for FinOps analytics:

1. **Deploy Lambda**:
   ```bash
   cd lambda
   zip function.zip lambda-finops-athena.js
   aws lambda create-function \
     --function-name finops-athena-query \
     --runtime nodejs18.x \
     --role arn:aws:iam::YOUR_ACCOUNT:role/lambda-athena-role \
     --handler index.handler \
     --zip-file fileb://function.zip
   ```

2. **Configure Environment Variables** in Lambda:
   ```
   ATHENA_DATABASE=your_database
   ATHENA_RESULTS_BUCKET=s3://your-bucket/results/
   AWS_ACCOUNT_NAMES={"123":"Prod","456":"Dev"}
   ```

3. **Create Function URL** for API access

4. **Grant Permissions**:
   - Athena query execution
   - S3 read/write to results bucket
   - CUR table access

## 📊 FinOps Dashboard Deep Dive

### Features

- **Real Savings Calculation**: Compare On-Demand pricing vs SP effective cost
- **Coverage Percentage**: See how much of your compute is covered by SPs
- **Savings Visualization**: Beautiful charts showing savings per account
- **AI Insights**: Get actionable recommendations powered by DeepSeek

### How It Works

1. Queries AWS Athena with your CUR data
2. Calculates Savings Plans coverage and savings
3. Compares current vs previous period for trends
4. Sends data to DeepSeek for AI analysis
5. Displays interactive dashboard with charts

### Sample Response

```json
{
  "summary": {
    "totalCost": 38679.80,
    "accountCount": 24
  },
  "savingsPlans": {
    "totalCoverage": 3105.42,
    "totalSavings": 3284.84,
    "byAccount": [
      {
        "accountName": "Production",
        "savings": 976.55,
        "savingsPercentage": 51.48,
        "coveragePercentage": 64.26
      }
    ]
  }
}
```

## 🛠️ Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS + shadcn/ui
- **Charts**: Recharts
- **AWS Services**: Lambda, Athena, S3, CUR
- **AI**: DeepSeek API
- **Automation**: N8N

## 📁 Project Structure

```
platform-portal/
├── src/
│   ├── app/                  # Next.js app router pages
│   │   ├── finops-athena/   # FinOps dashboard
│   │   ├── create-infra/    # Infrastructure requests
│   │   ├── create-repo/     # Repository creation
│   │   └── user-onboarding/ # User management
│   ├── components/          # React components
│   │   ├── finops/          # FinOps-specific components
│   │   ├── ui/              # shadcn/ui components
│   │   └── ...
│   └── types/               # TypeScript types
├── lambda-finops-athena.js  # Lambda function for FinOps
├── public/                  # Static assets
└── package.json
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with [Next.js](https://nextjs.org/)
- UI components from [shadcn/ui](https://ui.shadcn.com/)
- Charts powered by [Recharts](https://recharts.org/)
- AI analysis by [DeepSeek](https://www.deepseek.com/)

## 📧 Support

For questions or issues, please open an issue on GitHub.

---

**Made with ❤️ for Platform Engineering teams**
