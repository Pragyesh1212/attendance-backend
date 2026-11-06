
-- Create notification enum
CREATE TYPE "NotificationType" AS ENUM (
    'ATTENDANCE_APPROVAL',
    'ATTENDANCE_CORRECTION',
    'SYSTEM'
);

-- Create notifications table
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "type" "NotificationType" NOT NULL DEFAULT 'SYSTEM',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- Create index
CREATE INDEX "notifications_userId_isRead_createdAt_idx"
ON "notifications"("userId", "isRead", "createdAt");

-- Create foreign key
ALTER TABLE "notifications"
ADD CONSTRAINT "notifications_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
