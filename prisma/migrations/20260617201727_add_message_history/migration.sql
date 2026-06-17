-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "userPhoneNumber" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messages_userPhoneNumber_createdAt_idx" ON "messages"("userPhoneNumber", "createdAt");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_userPhoneNumber_fkey" FOREIGN KEY ("userPhoneNumber") REFERENCES "users"("phoneNumber") ON DELETE CASCADE ON UPDATE CASCADE;
