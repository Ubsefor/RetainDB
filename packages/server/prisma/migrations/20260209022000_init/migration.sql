-- CreateEnum
CREATE TYPE "OrganizationPlan" AS ENUM ('FREE', 'OSS', 'PAY_AS_YOU_GO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IntegrationType" AS ENUM ('GITHUB', 'GITLAB', 'BITBUCKET', 'JIRA', 'SLACK', 'TEAMS', 'WEBHOOK', 'OKTA', 'AZURE_AD');

-- CreateEnum
CREATE TYPE "OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER', 'SECURITY_ENGINEER', 'AUDITOR');

-- CreateEnum
CREATE TYPE "ScanType" AS ENUM ('FULL', 'DELTA', 'PR');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('OPEN', 'FIXED', 'IGNORED', 'FALSE_POSITIVE', 'RISK_ACCEPTED', 'IN_PROGRESS');

-- CreateEnum
CREATE TYPE "FixSessionStatus" AS ENUM ('GENERATED', 'APPROVED', 'APPLIED', 'ROLLED_BACK', 'REJECTED');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('USER', 'AI', 'SYSTEM');

-- CreateEnum
CREATE TYPE "UsageType" AS ENUM ('AI_TOKEN_COUNT', 'SCAN_COUNT', 'FIX_GENERATION_COUNT', 'CHAT_MESSAGE_COUNT');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('JSON', 'HTML', 'MARKDOWN', 'PDF');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'GENERATING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PRReviewStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "FeedbackType" AS ENUM ('DISMISS', 'FALSE_POSITIVE', 'HELPFUL', 'APPLIED_FIX', 'CUSTOM_RULE');

-- CreateEnum
CREATE TYPE "OSSApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('PENDING', 'CONNECTING', 'INDEXING', 'READY', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "SyncMode" AS ENUM ('MANUAL', 'SCHEDULED', 'REALTIME');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'ERROR', 'EXCLUDED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "avatarUrl" TEXT,
    "cliApiKey" TEXT,
    "passwordHash" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "hasSeenOnboarding" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastsigninAt" TIMESTAMP(3),
    "signinCount" INTEGER NOT NULL DEFAULT 0,
    "whopUserId" TEXT,
    "githubId" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "device" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "domain" TEXT,
    "plan" "OrganizationPlan" NOT NULL DEFAULT 'FREE',
    "aiQuotaLimit" INTEGER NOT NULL DEFAULT 5,
    "aiQuotaUsed" INTEGER NOT NULL DEFAULT 0,
    "billingCycle" TEXT NOT NULL DEFAULT 'monthly',
    "billingEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customBranding" JSONB,
    "dataRetentionDays" INTEGER NOT NULL DEFAULT 90,
    "enforceSSO" BOOLEAN NOT NULL DEFAULT false,
    "ipWhitelist" TEXT[],
    "membersLimit" INTEGER NOT NULL DEFAULT 3,
    "nextBillingDate" TIMESTAMP(3),
    "ownerId" TEXT NOT NULL,
    "projectsLimit" INTEGER NOT NULL DEFAULT 5,
    "requireMFA" BOOLEAN NOT NULL DEFAULT false,
    "ssoConfig" JSONB,
    "ssoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ssoProvider" TEXT,
    "stripeCustomerId" TEXT,
    "subscriptionId" TEXT,
    "subscriptionStatus" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isOnTrial" BOOLEAN NOT NULL DEFAULT false,
    "pricePerSeat" INTEGER NOT NULL DEFAULT 30,
    "pricingModel" TEXT NOT NULL DEFAULT 'per_seat',
    "seatCount" INTEGER NOT NULL DEFAULT 1,
    "trialEndsAt" TIMESTAMP(3),
    "trialStartedAt" TIMESTAMP(3),
    "website" TEXT,
    "whopSubscriptionId" TEXT,
    "githubMarketplaceAccountId" TEXT,
    "githubMarketplacePlanId" TEXT,
    "billingCustomerId" TEXT,
    "subscriptionPlan" TEXT,
    "subscriptionRenewsAt" TIMESTAMP(3),
    "usageStats" JSONB,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invitations" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL,
    "invitedById" TEXT,
    "token" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "type" "IntegrationType" NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "repositoryUrl" TEXT,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "scanSettings" JSONB NOT NULL DEFAULT '{}',
    "aiSettings" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scans" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "cliScanId" TEXT,
    "triggeredById" TEXT,
    "branch" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "scanType" "ScanType" NOT NULL DEFAULT 'FULL',
    "status" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "staticFindingsCount" INTEGER NOT NULL DEFAULT 0,
    "aiFindingsCount" INTEGER NOT NULL DEFAULT 0,
    "severityCounts" JSONB NOT NULL DEFAULT '{}',
    "performanceMetrics" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_jobs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "progress" JSONB NOT NULL DEFAULT '{"totalFiles": 0, "processedFiles": 0}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "logs" JSONB,

    CONSTRAINT "scan_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "findings" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "cliFindingId" TEXT,
    "ruleId" TEXT,
    "filePath" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER,
    "columnStart" INTEGER,
    "columnEnd" INTEGER,
    "severity" "FindingSeverity" NOT NULL DEFAULT 'MEDIUM',
    "category" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "aiAnalysis" JSONB NOT NULL DEFAULT '{}',
    "fixSuggestion" JSONB NOT NULL DEFAULT '{}',
    "status" "FindingStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToId" TEXT,
    "verifiedFixed" BOOLEAN NOT NULL DEFAULT false,
    "falsePositive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fingerprint" TEXT NOT NULL DEFAULT '',
    "firstSeenScanId" TEXT,
    "lastSeenScanId" TEXT,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finding_history" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "oldStatus" "FindingStatus",
    "newStatus" "FindingStatus" NOT NULL,
    "userId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fix_sessions" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fixType" TEXT,
    "originalCode" TEXT NOT NULL,
    "proposedFix" TEXT NOT NULL,
    "fixExplanation" TEXT,
    "confidenceScore" DOUBLE PRECISION,
    "status" "FixSessionStatus" NOT NULL DEFAULT 'GENERATED',
    "aiProvider" TEXT,
    "modelUsed" TEXT,
    "tokenUsage" JSONB,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "appliedById" TEXT,
    "appliedAt" TIMESTAMP(3),
    "rolledBackById" TEXT,
    "rolledBackAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "rejectionReason" TEXT,
    "rollbackReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fix_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT,
    "contextMetadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "tokensUsed" INTEGER,
    "modelUsed" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_policies" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_metrics" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "type" "UsageType" NOT NULL,
    "count" INTEGER NOT NULL,
    "model" TEXT,
    "contextId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "scan_id" TEXT,
    "project_id" TEXT,
    "user_id" TEXT NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" "ReportStatus" NOT NULL DEFAULT 'COMPLETED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_comparisons" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "currentScanId" TEXT NOT NULL,
    "previousScanId" TEXT NOT NULL,
    "newFindings" INTEGER NOT NULL DEFAULT 0,
    "fixedFindings" INTEGER NOT NULL DEFAULT 0,
    "unchangedFindings" INTEGER NOT NULL DEFAULT 0,
    "comparisonData" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_posts" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "coverImage" TEXT,
    "author" TEXT NOT NULL,
    "authorAvatar" TEXT,
    "publishedAt" TIMESTAMP(3),
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[],
    "views" INTEGER NOT NULL DEFAULT 0,
    "readTime" INTEGER NOT NULL,
    "status" "PostStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blog_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "docs" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_reviews" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "headBranch" TEXT NOT NULL,
    "headCommitSha" TEXT NOT NULL,
    "status" "PRReviewStatus" NOT NULL DEFAULT 'QUEUED',
    "scanId" TEXT,
    "commentsPosted" JSONB NOT NULL DEFAULT '[]',
    "reviewSummary" JSONB NOT NULL DEFAULT '{}',
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "webhookPayload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "pr_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_comments" (
    "id" TEXT NOT NULL,
    "prReviewId" TEXT NOT NULL,
    "findingId" TEXT,
    "githubCommentId" INTEGER,
    "body" TEXT NOT NULL,
    "path" TEXT,
    "line" INTEGER,
    "reactions" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pr_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviewed_commits" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "commitSha" TEXT NOT NULL,
    "scanId" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "findingsSnapshot" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "reviewed_commits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codebase_indexes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "treeSha" TEXT NOT NULL,
    "indexVersion" INTEGER NOT NULL DEFAULT 2,
    "functions" JSONB NOT NULL DEFAULT '[]',
    "classes" JSONB NOT NULL DEFAULT '[]',
    "imports" JSONB NOT NULL DEFAULT '[]',
    "securityControls" JSONB NOT NULL DEFAULT '{}',
    "embeddings" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "apiContracts" JSONB NOT NULL DEFAULT '{}',
    "authGraph" JSONB NOT NULL DEFAULT '{}',
    "businessLogic" JSONB NOT NULL DEFAULT '{}',
    "codeQuality" JSONB NOT NULL DEFAULT '{}',
    "configPatterns" JSONB NOT NULL DEFAULT '{}',
    "dataFlowPaths" JSONB NOT NULL DEFAULT '[]',
    "databaseSchema" JSONB NOT NULL DEFAULT '{}',
    "dependencySecurity" JSONB NOT NULL DEFAULT '{}',
    "domainEntities" JSONB NOT NULL DEFAULT '[]',
    "errorHandling" JSONB NOT NULL DEFAULT '{}',
    "performanceHints" JSONB NOT NULL DEFAULT '{}',
    "runtimePatterns" JSONB NOT NULL DEFAULT '{}',
    "testCoverage" JSONB NOT NULL DEFAULT '{}',
    "typeSystem" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "codebase_indexes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codebase_knowledge" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "embedding" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "source" TEXT NOT NULL DEFAULT 'auto',
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codebase_knowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historical_patterns" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "patternType" TEXT NOT NULL,
    "pattern" JSONB NOT NULL,
    "outcome" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historical_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repo_configs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "configSha" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "rawContent" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repo_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_summaries" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "prReviewId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "changedFiles" JSONB NOT NULL DEFAULT '[]',
    "impactAreas" JSONB NOT NULL DEFAULT '[]',
    "riskLevel" TEXT NOT NULL DEFAULT 'low',
    "diagram" TEXT,
    "keyChanges" JSONB NOT NULL DEFAULT '[]',
    "breakingChanges" JSONB NOT NULL DEFAULT '[]',
    "testCoverage" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_feedback" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "feedbackType" "FeedbackType" NOT NULL,
    "comment" TEXT,
    "rulePattern" TEXT,
    "filePath" TEXT,
    "lineNumber" INTEGER,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learned_rules" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "repoFullName" TEXT,
    "ruleType" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learned_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oss_applications" (
    "id" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "license" TEXT,
    "stars" INTEGER NOT NULL DEFAULT 0,
    "forks" INTEGER NOT NULL DEFAULT 0,
    "lastPushDate" TIMESTAMP(3),
    "email" TEXT,
    "status" "OSSApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "orgId" TEXT,
    "rejectionReason" TEXT,
    "verificationData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,

    CONSTRAINT "oss_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benchmark_results" (
    "id" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "repoStars" INTEGER NOT NULL,
    "repoLanguage" TEXT NOT NULL,
    "totalFindings" INTEGER NOT NULL,
    "criticalFindings" INTEGER NOT NULL,
    "highFindings" INTEGER NOT NULL,
    "mediumFindings" INTEGER NOT NULL,
    "lowFindings" INTEGER NOT NULL,
    "scanDuration" DOUBLE PRECISION NOT NULL,
    "categories" JSONB NOT NULL DEFAULT '{}',
    "scanId" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "competitorData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benchmark_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_codes" (
    "id" TEXT NOT NULL,
    "deviceCode" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "userId" TEXT,
    "apiKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "authorizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trust_scores" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "tokenName" TEXT NOT NULL DEFAULT 'Unknown',
    "tokenSymbol" TEXT NOT NULL DEFAULT '???',
    "tokenImage" TEXT NOT NULL DEFAULT '',
    "trustScore" INTEGER NOT NULL,
    "trustGrade" TEXT NOT NULL,
    "rugged" BOOLEAN NOT NULL DEFAULT false,
    "risks" JSONB NOT NULL DEFAULT '[]',
    "onChain" JSONB NOT NULL DEFAULT '{}',
    "rugCheckScore" INTEGER NOT NULL DEFAULT 0,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trust_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rateLimit" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "connectorType" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "status" "SourceStatus" NOT NULL DEFAULT 'PENDING',
    "syncMode" "SyncMode" NOT NULL DEFAULT 'MANUAL',
    "syncSchedule" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "syncError" TEXT,
    "syncErrorCount" INTEGER NOT NULL DEFAULT 0,
    "documentsCount" INTEGER NOT NULL DEFAULT 0,
    "documentCount" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncDurationMs" INTEGER,
    "bytesIndexed" BIGINT NOT NULL DEFAULT 0,
    "autoSync" BOOLEAN NOT NULL DEFAULT true,
    "branch" TEXT,
    "pathFilter" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "projectId" TEXT,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "path" TEXT,
    "mimeType" TEXT,
    "content" TEXT,
    "contentHash" TEXT,
    "size" BIGINT NOT NULL DEFAULT 0,
    "language" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "chunkingStrategy" TEXT,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "parseError" TEXT,
    "indexedAt" TIMESTAMP(3),
    "lastModified" TIMESTAMP(3),
    "webUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT,
    "chunkOrder" INTEGER,
    "chunkIndex" INTEGER,
    "chunkType" TEXT,
    "content" TEXT NOT NULL,
    "contentHash" TEXT,
    "searchContent" TEXT,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "tokenCount" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "importanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "parentChunkId" TEXT,
    "sectionPath" TEXT,
    "headingPath" TEXT,
    "rerankScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embeddings" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "vector" vector NOT NULL,
    "sparseVector" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_relations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "fromEntityId" TEXT NOT NULL,
    "toEntityId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "weight" DOUBLE PRECISION DEFAULT 1.0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entities" (
    "id" TEXT NOT NULL,
    "documentId" TEXT,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityType" TEXT,
    "value" TEXT,
    "description" TEXT,
    "sourceChunkId" TEXT,
    "embedding" vector,
    "parentId" TEXT,
    "parentPath" TEXT,
    "definitionPos" JSONB,
    "references" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "signature" TEXT,
    "accessLevel" TEXT,
    "language" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "projectId" TEXT,
    "userId" TEXT,
    "sessionId" TEXT,
    "agentId" TEXT,
    "memoryType" TEXT NOT NULL DEFAULT 'GENERAL',
    "content" TEXT NOT NULL,
    "embedding" vector,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "scope" TEXT NOT NULL DEFAULT 'USER',
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessedAt" TIMESTAMP(3),
    "lastRecalledAt" TIMESTAMP(3),
    "recallCount" INTEGER NOT NULL DEFAULT 0,
    "derivedFromId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "documentDate" TIMESTAMP(3),
    "eventDate" TIMESTAMP(3),
    "entityMentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "sourceChunkId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "validFrom" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "supersededBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_relations" (
    "id" TEXT NOT NULL,
    "fromMemoryId" TEXT NOT NULL,
    "toMemoryId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "reasoning" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "projectId" TEXT,
    "sessionId" TEXT,
    "userId" TEXT,
    "agentId" TEXT,
    "title" TEXT,
    "systemPrompt" TEXT,
    "contextId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastMessageAt" TIMESTAMP(3),
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "maxTokens" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "conversationId" TEXT,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "toolResults" JSONB,
    "contextUsed" JSONB,
    "tokens" INTEGER,
    "latencyMs" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunk_memories" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "relevanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chunk_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'FULL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "documentsTotal" INTEGER NOT NULL DEFAULT 0,
    "documentsIndexed" INTEGER NOT NULL DEFAULT 0,
    "documentsFailed" INTEGER NOT NULL DEFAULT 0,
    "bytesProcessed" BIGINT NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "logs" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sourceId" TEXT,
    "url" TEXT NOT NULL,
    "secret" TEXT,
    "events" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastTriggeredAt" TIMESTAMP(3),
    "lastDeliveredAt" TIMESTAMP(3),
    "lastStatusCode" INTEGER,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "statusCode" INTEGER,
    "responseBody" TEXT,
    "errorMessage" TEXT,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_logs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "query" TEXT NOT NULL,
    "queryType" TEXT NOT NULL DEFAULT 'SEMANTIC',
    "resultsCount" INTEGER NOT NULL DEFAULT 0,
    "resultIds" TEXT[],
    "semanticResults" INTEGER NOT NULL DEFAULT 0,
    "keywordResults" INTEGER NOT NULL DEFAULT 0,
    "graphResults" INTEGER NOT NULL DEFAULT 0,
    "totalLatencyMs" INTEGER NOT NULL,
    "embeddingLatencyMs" INTEGER,
    "searchLatencyMs" INTEGER,
    "rerankLatencyMs" INTEGER,
    "clickedResultId" TEXT,
    "feedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packages" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "autoSync" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" TIMESTAMP(3),
    "docsIndexed" INTEGER NOT NULL DEFAULT 0,
    "lastIndexedAt" TIMESTAMP(3),
    "registryUrl" TEXT,
    "packageJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_versions" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "documentsCount" INTEGER NOT NULL DEFAULT 0,
    "indexedAt" TIMESTAMP(3),
    "releaseDate" TIMESTAMP(3),
    "tarballUrl" TEXT,
    "dependencies" JSONB DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_sessions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INITIATED',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "totalSteps" INTEGER,
    "answer" TEXT,
    "sourcesUsed" TEXT[],
    "queriesExecuted" INTEGER NOT NULL DEFAULT 0,
    "totalLatencyMs" INTEGER,
    "tokensUsed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "research_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_steps" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "stepType" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "output" TEXT,
    "documentsUsed" TEXT[],
    "webResults" JSONB,
    "latencyMs" INTEGER,
    "tokensUsed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "queriesCount" INTEGER NOT NULL DEFAULT 0,
    "documentsIndexed" INTEGER NOT NULL DEFAULT 0,
    "tokensProcessed" BIGINT NOT NULL DEFAULT 0,
    "embeddingsGenerated" BIGINT NOT NULL DEFAULT 0,
    "storageBytes" BIGINT NOT NULL DEFAULT 0,
    "webSearches" INTEGER NOT NULL DEFAULT 0,
    "packageSearches" INTEGER NOT NULL DEFAULT 0,
    "researchQueries" INTEGER NOT NULL DEFAULT 0,
    "quotaLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "eventType" TEXT NOT NULL,
    "source" TEXT,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "embeddingTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 1,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "query_cache" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "queryHash" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "results" JSONB NOT NULL DEFAULT '[]',
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "query_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChunkDocument" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "relevanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChunkDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_cliApiKey_key" ON "users"("cliApiKey");

-- CreateIndex
CREATE UNIQUE INDEX "users_whopUserId_key" ON "users"("whopUserId");

-- CreateIndex
CREATE UNIQUE INDEX "users_githubId_key" ON "users"("githubId");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE INDEX "users_cliApiKey_idx" ON "users"("cliApiKey");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_tokenHash_key" ON "user_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "user_sessions_userId_idx" ON "user_sessions"("userId");

-- CreateIndex
CREATE INDEX "user_sessions_expiresAt_idx" ON "user_sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_githubMarketplaceAccountId_key" ON "organizations"("githubMarketplaceAccountId");

-- CreateIndex
CREATE INDEX "organizations_name_idx" ON "organizations"("name");

-- CreateIndex
CREATE INDEX "organizations_ownerId_idx" ON "organizations"("ownerId");

-- CreateIndex
CREATE INDEX "organizations_subscriptionStatus_plan_idx" ON "organizations"("subscriptionStatus", "plan");

-- CreateIndex
CREATE INDEX "organizations_isOnTrial_trialEndsAt_idx" ON "organizations"("isOnTrial", "trialEndsAt");

-- CreateIndex
CREATE INDEX "organization_members_userId_idx" ON "organization_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_orgId_userId_key" ON "organization_members"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_token_key" ON "organization_invitations"("token");

-- CreateIndex
CREATE INDEX "organization_invitations_orgId_idx" ON "organization_invitations"("orgId");

-- CreateIndex
CREATE INDEX "organization_invitations_invitedById_idx" ON "organization_invitations"("invitedById");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_orgId_email_key" ON "organization_invitations"("orgId", "email");

-- CreateIndex
CREATE INDEX "integrations_orgId_type_idx" ON "integrations"("orgId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_orgId_type_name_key" ON "integrations"("orgId", "type", "name");

-- CreateIndex
CREATE INDEX "audit_logs_orgId_createdAt_action_idx" ON "audit_logs"("orgId", "createdAt", "action");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_orgId_action_createdAt_idx" ON "audit_logs"("orgId", "action", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "billing_events_stripeEventId_key" ON "billing_events"("stripeEventId");

-- CreateIndex
CREATE INDEX "billing_events_orgId_type_idx" ON "billing_events"("orgId", "type");

-- CreateIndex
CREATE INDEX "billing_events_createdAt_idx" ON "billing_events"("createdAt");

-- CreateIndex
CREATE INDEX "projects_createdAt_idx" ON "projects"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "projects_orgId_name_key" ON "projects"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "projects_orgId_slug_key" ON "projects"("orgId", "slug");

-- CreateIndex
CREATE INDEX "scans_projectId_branch_createdAt_idx" ON "scans"("projectId", "branch", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "scans_status_idx" ON "scans"("status");

-- CreateIndex
CREATE INDEX "scans_projectId_status_completedAt_idx" ON "scans"("projectId", "status", "completedAt" DESC);

-- CreateIndex
CREATE INDEX "scan_jobs_status_createdAt_idx" ON "scan_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "scan_jobs_updatedAt_idx" ON "scan_jobs"("updatedAt");

-- CreateIndex
CREATE INDEX "findings_scanId_status_severity_idx" ON "findings"("scanId", "status", "severity");

-- CreateIndex
CREATE INDEX "findings_assignedToId_status_idx" ON "findings"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "findings_filePath_idx" ON "findings"("filePath");

-- CreateIndex
CREATE INDEX "findings_scanId_severity_createdAt_idx" ON "findings"("scanId", "severity", "createdAt");

-- CreateIndex
CREATE INDEX "findings_fingerprint_idx" ON "findings"("fingerprint");

-- CreateIndex
CREATE INDEX "findings_firstSeenScanId_idx" ON "findings"("firstSeenScanId");

-- CreateIndex
CREATE INDEX "finding_history_findingId_createdAt_idx" ON "finding_history"("findingId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "finding_history_findingId_newStatus_createdAt_idx" ON "finding_history"("findingId", "newStatus", "createdAt");

-- CreateIndex
CREATE INDEX "fix_sessions_userId_idx" ON "fix_sessions"("userId");

-- CreateIndex
CREATE INDEX "fix_sessions_findingId_idx" ON "fix_sessions"("findingId");

-- CreateIndex
CREATE INDEX "fix_sessions_status_idx" ON "fix_sessions"("status");

-- CreateIndex
CREATE INDEX "chat_conversations_userId_idx" ON "chat_conversations"("userId");

-- CreateIndex
CREATE INDEX "chat_conversations_projectId_idx" ON "chat_conversations"("projectId");

-- CreateIndex
CREATE INDEX "chat_conversations_createdAt_idx" ON "chat_conversations"("createdAt");

-- CreateIndex
CREATE INDEX "chat_conversations_userId_projectId_createdAt_idx" ON "chat_conversations"("userId", "projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "chat_messages_conversationId_idx" ON "chat_messages"("conversationId");

-- CreateIndex
CREATE INDEX "chat_messages_userId_idx" ON "chat_messages"("userId");

-- CreateIndex
CREATE INDEX "chat_messages_createdAt_idx" ON "chat_messages"("createdAt");

-- CreateIndex
CREATE INDEX "security_policies_enabled_idx" ON "security_policies"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "security_policies_orgId_name_key" ON "security_policies"("orgId", "name");

-- CreateIndex
CREATE INDEX "usage_metrics_orgId_type_timestamp_idx" ON "usage_metrics"("orgId", "type", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "usage_metrics_userId_type_idx" ON "usage_metrics"("userId", "type");

-- CreateIndex
CREATE INDEX "reports_scan_id_idx" ON "reports"("scan_id");

-- CreateIndex
CREATE INDEX "reports_project_id_idx" ON "reports"("project_id");

-- CreateIndex
CREATE INDEX "reports_user_id_idx" ON "reports"("user_id");

-- CreateIndex
CREATE INDEX "reports_created_at_idx" ON "reports"("created_at" DESC);

-- CreateIndex
CREATE INDEX "reports_format_idx" ON "reports"("format");

-- CreateIndex
CREATE INDEX "scan_comparisons_projectId_createdAt_idx" ON "scan_comparisons"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "scan_comparisons_currentScanId_previousScanId_key" ON "scan_comparisons"("currentScanId", "previousScanId");

-- CreateIndex
CREATE UNIQUE INDEX "blog_posts_slug_key" ON "blog_posts"("slug");

-- CreateIndex
CREATE INDEX "blog_posts_publishedAt_idx" ON "blog_posts"("publishedAt");

-- CreateIndex
CREATE INDEX "blog_posts_slug_idx" ON "blog_posts"("slug");

-- CreateIndex
CREATE INDEX "blog_posts_status_idx" ON "blog_posts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "docs_slug_key" ON "docs"("slug");

-- CreateIndex
CREATE INDEX "docs_category_idx" ON "docs"("category");

-- CreateIndex
CREATE INDEX "docs_slug_idx" ON "docs"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "pr_reviews_scanId_key" ON "pr_reviews"("scanId");

-- CreateIndex
CREATE INDEX "pr_reviews_orgId_status_idx" ON "pr_reviews"("orgId", "status");

-- CreateIndex
CREATE INDEX "pr_reviews_repoFullName_prNumber_idx" ON "pr_reviews"("repoFullName", "prNumber");

-- CreateIndex
CREATE INDEX "pr_reviews_status_createdAt_idx" ON "pr_reviews"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "pr_reviews_repoFullName_prNumber_headCommitSha_key" ON "pr_reviews"("repoFullName", "prNumber", "headCommitSha");

-- CreateIndex
CREATE INDEX "pr_comments_prReviewId_idx" ON "pr_comments"("prReviewId");

-- CreateIndex
CREATE INDEX "pr_comments_githubCommentId_idx" ON "pr_comments"("githubCommentId");

-- CreateIndex
CREATE INDEX "pr_comments_findingId_idx" ON "pr_comments"("findingId");

-- CreateIndex
CREATE INDEX "reviewed_commits_repoFullName_prNumber_idx" ON "reviewed_commits"("repoFullName", "prNumber");

-- CreateIndex
CREATE INDEX "reviewed_commits_commitSha_idx" ON "reviewed_commits"("commitSha");

-- CreateIndex
CREATE UNIQUE INDEX "reviewed_commits_repoFullName_prNumber_commitSha_key" ON "reviewed_commits"("repoFullName", "prNumber", "commitSha");

-- CreateIndex
CREATE INDEX "codebase_indexes_orgId_projectId_idx" ON "codebase_indexes"("orgId", "projectId");

-- CreateIndex
CREATE INDEX "codebase_indexes_repoFullName_idx" ON "codebase_indexes"("repoFullName");

-- CreateIndex
CREATE UNIQUE INDEX "codebase_indexes_projectId_treeSha_key" ON "codebase_indexes"("projectId", "treeSha");

-- CreateIndex
CREATE INDEX "codebase_knowledge_orgId_projectId_idx" ON "codebase_knowledge"("orgId", "projectId");

-- CreateIndex
CREATE INDEX "codebase_knowledge_category_idx" ON "codebase_knowledge"("category");

-- CreateIndex
CREATE UNIQUE INDEX "codebase_knowledge_projectId_category_key_key" ON "codebase_knowledge"("projectId", "category", "key");

-- CreateIndex
CREATE INDEX "historical_patterns_orgId_patternType_idx" ON "historical_patterns"("orgId", "patternType");

-- CreateIndex
CREATE INDEX "historical_patterns_projectId_patternType_idx" ON "historical_patterns"("projectId", "patternType");

-- CreateIndex
CREATE UNIQUE INDEX "repo_configs_repoFullName_key" ON "repo_configs"("repoFullName");

-- CreateIndex
CREATE INDEX "repo_configs_orgId_idx" ON "repo_configs"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "pr_summaries_prReviewId_key" ON "pr_summaries"("prReviewId");

-- CreateIndex
CREATE INDEX "pr_summaries_orgId_idx" ON "pr_summaries"("orgId");

-- CreateIndex
CREATE INDEX "pr_summaries_repoFullName_prNumber_idx" ON "pr_summaries"("repoFullName", "prNumber");

-- CreateIndex
CREATE INDEX "review_feedback_orgId_idx" ON "review_feedback"("orgId");

-- CreateIndex
CREATE INDEX "review_feedback_repoFullName_idx" ON "review_feedback"("repoFullName");

-- CreateIndex
CREATE INDEX "review_feedback_rulePattern_idx" ON "review_feedback"("rulePattern");

-- CreateIndex
CREATE INDEX "learned_rules_orgId_idx" ON "learned_rules"("orgId");

-- CreateIndex
CREATE INDEX "learned_rules_ruleType_idx" ON "learned_rules"("ruleType");

-- CreateIndex
CREATE UNIQUE INDEX "learned_rules_orgId_repoFullName_pattern_key" ON "learned_rules"("orgId", "repoFullName", "pattern");

-- CreateIndex
CREATE UNIQUE INDEX "oss_applications_repoUrl_key" ON "oss_applications"("repoUrl");

-- CreateIndex
CREATE UNIQUE INDEX "oss_applications_orgId_key" ON "oss_applications"("orgId");

-- CreateIndex
CREATE INDEX "oss_applications_status_idx" ON "oss_applications"("status");

-- CreateIndex
CREATE INDEX "oss_applications_orgId_idx" ON "oss_applications"("orgId");

-- CreateIndex
CREATE INDEX "oss_applications_createdAt_idx" ON "oss_applications"("createdAt");

-- CreateIndex
CREATE INDEX "benchmark_results_scannedAt_idx" ON "benchmark_results"("scannedAt");

-- CreateIndex
CREATE INDEX "benchmark_results_repoOwner_repoName_idx" ON "benchmark_results"("repoOwner", "repoName");

-- CreateIndex
CREATE UNIQUE INDEX "device_codes_deviceCode_key" ON "device_codes"("deviceCode");

-- CreateIndex
CREATE UNIQUE INDEX "device_codes_userCode_key" ON "device_codes"("userCode");

-- CreateIndex
CREATE INDEX "device_codes_deviceCode_idx" ON "device_codes"("deviceCode");

-- CreateIndex
CREATE INDEX "device_codes_userCode_idx" ON "device_codes"("userCode");

-- CreateIndex
CREATE INDEX "device_codes_status_expiresAt_idx" ON "device_codes"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "trust_scores_mint_key" ON "trust_scores"("mint");

-- CreateIndex
CREATE INDEX "trust_scores_trustGrade_idx" ON "trust_scores"("trustGrade");

-- CreateIndex
CREATE INDEX "trust_scores_scannedAt_idx" ON "trust_scores"("scannedAt");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyId_key" ON "api_keys"("keyId");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyPrefix_key" ON "api_keys"("keyPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_orgId_idx" ON "api_keys"("orgId");

-- CreateIndex
CREATE INDEX "api_keys_userId_idx" ON "api_keys"("userId");

-- CreateIndex
CREATE INDEX "api_keys_keyPrefix_idx" ON "api_keys"("keyPrefix");

-- CreateIndex
CREATE INDEX "api_keys_revoked_expiresAt_idx" ON "api_keys"("revoked", "expiresAt");

-- CreateIndex
CREATE INDEX "sources_orgId_idx" ON "sources"("orgId");

-- CreateIndex
CREATE INDEX "sources_projectId_idx" ON "sources"("projectId");

-- CreateIndex
CREATE INDEX "sources_type_idx" ON "sources"("type");

-- CreateIndex
CREATE INDEX "sources_status_idx" ON "sources"("status");

-- CreateIndex
CREATE INDEX "sources_syncMode_idx" ON "sources"("syncMode");

-- CreateIndex
CREATE UNIQUE INDEX "sources_orgId_name_key" ON "sources"("orgId", "name");

-- CreateIndex
CREATE INDEX "documents_sourceId_idx" ON "documents"("sourceId");

-- CreateIndex
CREATE INDEX "documents_contentHash_idx" ON "documents"("contentHash");

-- CreateIndex
CREATE INDEX "documents_status_idx" ON "documents"("status");

-- CreateIndex
CREATE INDEX "documents_mimeType_idx" ON "documents"("mimeType");

-- CreateIndex
CREATE INDEX "documents_language_idx" ON "documents"("language");

-- CreateIndex
CREATE INDEX "documents_createdAt_idx" ON "documents"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "documents_sourceId_externalId_key" ON "documents"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "chunks_documentId_idx" ON "chunks"("documentId");

-- CreateIndex
CREATE INDEX "chunks_contentHash_idx" ON "chunks"("contentHash");

-- CreateIndex
CREATE INDEX "chunks_sectionPath_idx" ON "chunks"("sectionPath");

-- CreateIndex
CREATE INDEX "chunks_parentChunkId_idx" ON "chunks"("parentChunkId");

-- CreateIndex
CREATE INDEX "chunks_createdAt_idx" ON "chunks"("createdAt");

-- CreateIndex
CREATE INDEX "embeddings_chunkId_idx" ON "embeddings"("chunkId");

-- CreateIndex
CREATE INDEX "embeddings_model_idx" ON "embeddings"("model");

-- CreateIndex
CREATE INDEX "entity_relations_projectId_idx" ON "entity_relations"("projectId");

-- CreateIndex
CREATE INDEX "entity_relations_fromEntityId_idx" ON "entity_relations"("fromEntityId");

-- CreateIndex
CREATE INDEX "entity_relations_toEntityId_idx" ON "entity_relations"("toEntityId");

-- CreateIndex
CREATE INDEX "entity_relations_relationType_idx" ON "entity_relations"("relationType");

-- CreateIndex
CREATE UNIQUE INDEX "entity_relations_fromEntityId_toEntityId_relationType_key" ON "entity_relations"("fromEntityId", "toEntityId", "relationType");

-- CreateIndex
CREATE INDEX "entities_documentId_idx" ON "entities"("documentId");

-- CreateIndex
CREATE INDEX "entities_name_idx" ON "entities"("name");

-- CreateIndex
CREATE INDEX "entities_type_idx" ON "entities"("type");

-- CreateIndex
CREATE INDEX "entities_parentId_idx" ON "entities"("parentId");

-- CreateIndex
CREATE INDEX "entities_parentPath_idx" ON "entities"("parentPath");

-- CreateIndex
CREATE UNIQUE INDEX "entities_projectId_name_entityType_key" ON "entities"("projectId", "name", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "entities_documentId_name_type_key" ON "entities"("documentId", "name", "type");

-- CreateIndex
CREATE INDEX "memories_orgId_idx" ON "memories"("orgId");

-- CreateIndex
CREATE INDEX "memories_projectId_idx" ON "memories"("projectId");

-- CreateIndex
CREATE INDEX "memories_userId_idx" ON "memories"("userId");

-- CreateIndex
CREATE INDEX "memories_sessionId_idx" ON "memories"("sessionId");

-- CreateIndex
CREATE INDEX "memories_agentId_idx" ON "memories"("agentId");

-- CreateIndex
CREATE INDEX "memories_memoryType_idx" ON "memories"("memoryType");

-- CreateIndex
CREATE INDEX "memories_scope_idx" ON "memories"("scope");

-- CreateIndex
CREATE INDEX "memories_expiresAt_idx" ON "memories"("expiresAt");

-- CreateIndex
CREATE INDEX "memories_isActive_idx" ON "memories"("isActive");

-- CreateIndex
CREATE INDEX "memories_documentDate_eventDate_idx" ON "memories"("documentDate", "eventDate");

-- CreateIndex
CREATE INDEX "memories_validFrom_validUntil_idx" ON "memories"("validFrom", "validUntil");

-- CreateIndex
CREATE INDEX "memories_confidence_idx" ON "memories"("confidence");

-- CreateIndex
CREATE INDEX "memories_sourceChunkId_idx" ON "memories"("sourceChunkId");

-- CreateIndex
CREATE INDEX "memories_supersededBy_idx" ON "memories"("supersededBy");

-- CreateIndex
CREATE INDEX "memories_entityMentions_idx" ON "memories"("entityMentions");

-- CreateIndex
CREATE INDEX "memory_relations_fromMemoryId_idx" ON "memory_relations"("fromMemoryId");

-- CreateIndex
CREATE INDEX "memory_relations_toMemoryId_idx" ON "memory_relations"("toMemoryId");

-- CreateIndex
CREATE INDEX "memory_relations_relationType_idx" ON "memory_relations"("relationType");

-- CreateIndex
CREATE INDEX "memory_relations_fromMemoryId_toMemoryId_idx" ON "memory_relations"("fromMemoryId", "toMemoryId");

-- CreateIndex
CREATE UNIQUE INDEX "memory_relations_unique" ON "memory_relations"("fromMemoryId", "toMemoryId", "relationType");

-- CreateIndex
CREATE INDEX "sessions_orgId_idx" ON "sessions"("orgId");

-- CreateIndex
CREATE INDEX "sessions_projectId_idx" ON "sessions"("projectId");

-- CreateIndex
CREATE INDEX "sessions_sessionId_idx" ON "sessions"("sessionId");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_agentId_idx" ON "sessions"("agentId");

-- CreateIndex
CREATE INDEX "sessions_status_idx" ON "sessions"("status");

-- CreateIndex
CREATE INDEX "sessions_createdAt_idx" ON "sessions"("createdAt");

-- CreateIndex
CREATE INDEX "messages_sessionId_idx" ON "messages"("sessionId");

-- CreateIndex
CREATE INDEX "messages_conversationId_idx" ON "messages"("conversationId");

-- CreateIndex
CREATE INDEX "messages_role_idx" ON "messages"("role");

-- CreateIndex
CREATE INDEX "messages_createdAt_idx" ON "messages"("createdAt");

-- CreateIndex
CREATE INDEX "chunk_memories_chunkId_idx" ON "chunk_memories"("chunkId");

-- CreateIndex
CREATE INDEX "chunk_memories_memoryId_idx" ON "chunk_memories"("memoryId");

-- CreateIndex
CREATE UNIQUE INDEX "chunk_memories_chunkId_memoryId_key" ON "chunk_memories"("chunkId", "memoryId");

-- CreateIndex
CREATE INDEX "sync_jobs_sourceId_idx" ON "sync_jobs"("sourceId");

-- CreateIndex
CREATE INDEX "sync_jobs_status_idx" ON "sync_jobs"("status");

-- CreateIndex
CREATE INDEX "sync_jobs_type_idx" ON "sync_jobs"("type");

-- CreateIndex
CREATE INDEX "sync_jobs_createdAt_idx" ON "sync_jobs"("createdAt");

-- CreateIndex
CREATE INDEX "webhooks_orgId_idx" ON "webhooks"("orgId");

-- CreateIndex
CREATE INDEX "webhooks_status_idx" ON "webhooks"("status");

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhookId_idx" ON "webhook_deliveries"("webhookId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries"("event");

-- CreateIndex
CREATE INDEX "webhook_deliveries_deliveredAt_idx" ON "webhook_deliveries"("deliveredAt");

-- CreateIndex
CREATE INDEX "search_logs_orgId_idx" ON "search_logs"("orgId");

-- CreateIndex
CREATE INDEX "search_logs_userId_idx" ON "search_logs"("userId");

-- CreateIndex
CREATE INDEX "search_logs_sessionId_idx" ON "search_logs"("sessionId");

-- CreateIndex
CREATE INDEX "search_logs_queryType_idx" ON "search_logs"("queryType");

-- CreateIndex
CREATE INDEX "search_logs_createdAt_idx" ON "search_logs"("createdAt");

-- CreateIndex
CREATE INDEX "packages_ecosystem_idx" ON "packages"("ecosystem");

-- CreateIndex
CREATE UNIQUE INDEX "packages_orgId_ecosystem_name_key" ON "packages"("orgId", "ecosystem", "name");

-- CreateIndex
CREATE INDEX "package_versions_status_idx" ON "package_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "package_versions_packageId_version_key" ON "package_versions"("packageId", "version");

-- CreateIndex
CREATE INDEX "research_sessions_orgId_idx" ON "research_sessions"("orgId");

-- CreateIndex
CREATE INDEX "research_sessions_userId_idx" ON "research_sessions"("userId");

-- CreateIndex
CREATE INDEX "research_sessions_status_idx" ON "research_sessions"("status");

-- CreateIndex
CREATE INDEX "research_sessions_createdAt_idx" ON "research_sessions"("createdAt");

-- CreateIndex
CREATE INDEX "research_steps_sessionId_idx" ON "research_steps"("sessionId");

-- CreateIndex
CREATE INDEX "research_steps_stepOrder_idx" ON "research_steps"("stepOrder");

-- CreateIndex
CREATE INDEX "usage_records_period_idx" ON "usage_records"("period");

-- CreateIndex
CREATE UNIQUE INDEX "usage_records_orgId_period_key" ON "usage_records"("orgId", "period");

-- CreateIndex
CREATE INDEX "usage_events_orgId_eventType_idx" ON "usage_events"("orgId", "eventType");

-- CreateIndex
CREATE INDEX "usage_events_orgId_createdAt_idx" ON "usage_events"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "usage_events_projectId_idx" ON "usage_events"("projectId");

-- CreateIndex
CREATE INDEX "query_cache_expiresAt_idx" ON "query_cache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "query_cache_projectId_queryHash_key" ON "query_cache"("projectId", "queryHash");

-- CreateIndex
CREATE INDEX "ChunkDocument_chunkId_idx" ON "ChunkDocument"("chunkId");

-- CreateIndex
CREATE INDEX "ChunkDocument_documentId_idx" ON "ChunkDocument"("documentId");

-- CreateIndex
CREATE INDEX "DocumentChunk_documentId_idx" ON "DocumentChunk"("documentId");

-- CreateIndex
CREATE INDEX "DocumentChunk_chunkId_idx" ON "DocumentChunk"("chunkId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChunk_documentId_chunkId_key" ON "DocumentChunk"("documentId", "chunkId");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_firstSeenScanId_fkey" FOREIGN KEY ("firstSeenScanId") REFERENCES "scans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_lastSeenScanId_fkey" FOREIGN KEY ("lastSeenScanId") REFERENCES "scans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding_history" ADD CONSTRAINT "finding_history_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fix_sessions" ADD CONSTRAINT "fix_sessions_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fix_sessions" ADD CONSTRAINT "fix_sessions_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fix_sessions" ADD CONSTRAINT "fix_sessions_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fix_sessions" ADD CONSTRAINT "fix_sessions_rolledBackById_fkey" FOREIGN KEY ("rolledBackById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fix_sessions" ADD CONSTRAINT "fix_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_policies" ADD CONSTRAINT "security_policies_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_policies" ADD CONSTRAINT "security_policies_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_metrics" ADD CONSTRAINT "usage_metrics_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_comparisons" ADD CONSTRAINT "scan_comparisons_currentScanId_fkey" FOREIGN KEY ("currentScanId") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_comparisons" ADD CONSTRAINT "scan_comparisons_previousScanId_fkey" FOREIGN KEY ("previousScanId") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_comparisons" ADD CONSTRAINT "scan_comparisons_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oss_applications" ADD CONSTRAINT "oss_applications_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_parentChunkId_fkey" FOREIGN KEY ("parentChunkId") REFERENCES "chunks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_fromEntityId_fkey" FOREIGN KEY ("fromEntityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_toEntityId_fkey" FOREIGN KEY ("toEntityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_sourceChunkId_fkey" FOREIGN KEY ("sourceChunkId") REFERENCES "chunks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_supersededBy_fkey" FOREIGN KEY ("supersededBy") REFERENCES "memories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_fromMemoryId_fkey" FOREIGN KEY ("fromMemoryId") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_toMemoryId_fkey" FOREIGN KEY ("toMemoryId") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk_memories" ADD CONSTRAINT "chunk_memories_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

