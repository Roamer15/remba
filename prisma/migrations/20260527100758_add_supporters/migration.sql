-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mentorId" TEXT;

-- CreateTable
CREATE TABLE "mentors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,

    CONSTRAINT "mentors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mentors_phoneNumber_key" ON "mentors"("phoneNumber");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "mentors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
