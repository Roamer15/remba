// src/modules/agent/tools.ts
import type { ChatCompletionTool } from 'openai/resources.js';
import type { User } from 'src/generated/prisma/client';
import { PrismaService } from 'src/prisma.service';
import { AnalyticsService } from '../scheduler/analytics.service';

/**
 * JSON-schema definitions advertised to the model. The model chooses which of
 * these to call; AgentService dispatches the call to the matching handler.
 */
export const TOOL_SCHEMAS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'create_medication_reminders',
      description:
        'Register one or more medication reminders for the patient. Use whenever the patient wants to add/schedule a medication. Map vague periods to 24h times: morning=08:00, afternoon=13:00, evening=19:00, night=21:00. Emit one entry per (medication, time) — e.g. "twice a day at 8am and 8pm" becomes two entries.',
      parameters: {
        type: 'object',
        properties: {
          reminders: {
            type: 'array',
            description: 'The medication reminders to create.',
            items: {
              type: 'object',
              properties: {
                medicationName: {
                  type: 'string',
                  description: 'Name of the medication, e.g. "Amoxicillin".',
                },
                reminderTime: {
                  type: 'string',
                  description: '24-hour time in HH:MM format, e.g. "08:00".',
                },
              },
              required: ['medicationName', 'reminderTime'],
            },
          },
        },
        required: ['reminders'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_dose',
      description:
        "Record whether the patient took or skipped their most recent due dose. Use when they confirm taking it (e.g. \"taken\", \"done\", \"yes I took it\") or report missing/skipping it. Applies to the patient's latest pending dose alert.",
      parameters: {
        type: 'object',
        properties: {
          intent: {
            type: 'string',
            enum: ['TAKEN', 'SKIP'],
            description: 'TAKEN if they took the dose, SKIP if they missed it.',
          },
          skipReasonCategory: {
            type: 'string',
            enum: ['SIDE_EFFECTS', 'OUT_OF_STOCK', 'FORGOT', 'OTHER'],
            description: 'Only when intent is SKIP: the main barrier category.',
          },
          skipReasonNotes: {
            type: 'string',
            description:
              'Only when intent is SKIP: a concise English note (max ~10 words), e.g. "Experiencing severe dizziness".',
          },
        },
        required: ['intent'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weekly_report',
      description:
        "Generate the patient's 7-day adherence report. Use when they ask for their report, bilan, progress, stats, or how they have been doing. The tool returns a fully formatted report string in 'reportText' which you MUST deliver to the patient VERBATIM, without rewording the numbers.",
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'link_mentor',
      description:
        'Assign a treatment supporter / mentor / caretaker who will be alerted automatically if the patient repeatedly misses doses.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: "The mentor's name.",
          },
          phoneNumber: {
            type: 'string',
            description:
              "The mentor's WhatsApp phone number including country code, digits only.",
          },
        },
        required: ['name', 'phoneNumber'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description:
        "List the patient's current active medication reminders (names, times, streaks). Use when they ask what medications or reminders they have.",
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_reminder',
      description:
        'Change the time of an EXISTING medication reminder. Use when the patient wants to move/reschedule a reminder they already have (e.g. "move my morning Amoxicillin to 9am"). Do NOT use create_medication_reminders for changes — that would create a duplicate.',
      parameters: {
        type: 'object',
        properties: {
          medicationName: {
            type: 'string',
            description: 'Name of the medication whose reminder is changing.',
          },
          currentTime: {
            type: 'string',
            description:
              'The existing 24h HH:MM time of the reminder to change (from the active reminders list).',
          },
          newTime: {
            type: 'string',
            description: 'The new 24h HH:MM time.',
          },
        },
        required: ['medicationName', 'currentTime', 'newTime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_reminder',
      description:
        'Stop/cancel a medication reminder. Use when the patient no longer wants reminders for a medication (e.g. "stop reminding me about Vitamin C"). If a specific time is given, cancel only that one; otherwise cancel all reminders for that medication.',
      parameters: {
        type: 'object',
        properties: {
          medicationName: {
            type: 'string',
            description: 'Name of the medication to stop reminding about.',
          },
          time: {
            type: 'string',
            description:
              'Optional 24h HH:MM of the specific reminder to cancel. Omit to cancel all reminders for this medication.',
          },
        },
        required: ['medicationName'],
      },
    },
  },
];

export interface ToolDeps {
  prisma: PrismaService;
  analytics: AnalyticsService;
}

export type ToolHandler = (
  args: Record<string, any>,
  user: User,
) => Promise<Record<string, unknown>>;

/**
 * Builds the name -> handler map. Each handler wraps existing Prisma logic and
 * returns JSON-serializable data only (no WhatsApp sends — the agent composes
 * the user-facing reply from these results).
 */
export function buildToolRegistry(deps: ToolDeps): Record<string, ToolHandler> {
  const { prisma, analytics } = deps;

  return {
    async create_medication_reminders(args, user) {
      const requested: Array<{ medicationName: string; reminderTime: string }> =
        Array.isArray(args.reminders) ? args.reminders : [];

      if (requested.length === 0) {
        return { created: [], duplicates: [], note: 'No reminders provided.' };
      }

      const existing = await prisma.reminder.findMany({
        where: { userPhoneNumber: user.phoneNumber },
      });

      const created: typeof requested = [];
      const duplicates: typeof requested = [];

      for (const rem of requested) {
        const isDuplicate = existing.some(
          (e) =>
            e.medicationName.toLowerCase() ===
              rem.medicationName.toLowerCase() &&
            e.reminderTime === rem.reminderTime,
        );

        if (isDuplicate) {
          duplicates.push(rem);
          continue;
        }

        await prisma.reminder.create({
          data: {
            medicationName: rem.medicationName,
            reminderTime: rem.reminderTime,
            user: { connect: { phoneNumber: user.phoneNumber } },
          },
        });
        created.push(rem);
      }

      return { created, duplicates };
    },

    async log_dose(args, user) {
      const latestPendingLog = await prisma.doseLog.findFirst({
        where: {
          status: 'PENDING',
          reminder: { userPhoneNumber: user.phoneNumber },
        },
        orderBy: { timestamp: 'desc' },
        include: { reminder: true },
      });

      if (!latestPendingLog) {
        return { hadPendingDose: false };
      }

      const diffInMinutes = Math.floor(
        (Date.now() - new Date(latestPendingLog.timestamp).getTime()) /
          (1000 * 60),
      );

      let finalStatus: 'TAKEN' | 'TAKEN_LATE' | 'SKIPPED' = 'TAKEN';
      if (args.intent === 'TAKEN') {
        if (diffInMinutes > 60 && diffInMinutes <= 240) {
          finalStatus = 'TAKEN_LATE';
        } else if (diffInMinutes > 240) {
          finalStatus = 'SKIPPED';
        }
      } else if (args.intent === 'SKIP') {
        finalStatus = 'SKIPPED';
      }

      let newStreak = latestPendingLog.reminder.streakCount;

      await prisma.$transaction(async (tx) => {
        await tx.doseLog.update({
          where: { id: latestPendingLog.id },
          data: {
            status: finalStatus,
            notes: args.skipReasonNotes || null,
          },
        });

        if (finalStatus === 'TAKEN') {
          newStreak += 1;
          await tx.reminder.update({
            where: { id: latestPendingLog.reminderId },
            data: { streakCount: { increment: 1 } },
          });
        } else if (finalStatus === 'SKIPPED') {
          newStreak = 0;
          await tx.reminder.update({
            where: { id: latestPendingLog.reminderId },
            data: { streakCount: 0 },
          });
        }
      });

      return {
        hadPendingDose: true,
        status: finalStatus,
        medicationName: latestPendingLog.reminder.medicationName,
        streak: newStreak,
        minutesAfterDue: diffInMinutes,
      };
    },

    async get_weekly_report(_args, user) {
      const reportText = await analytics.buildWeeklyReport(user.phoneNumber);
      return { reportText };
    },

    async link_mentor(args, user) {
      await prisma.$transaction(async (tx) => {
        const mentor = await tx.mentor.upsert({
          where: { phoneNumber: args.phoneNumber },
          create: { name: args.name, phoneNumber: args.phoneNumber },
          update: { name: args.name },
        });

        await tx.user.update({
          where: { phoneNumber: user.phoneNumber },
          data: { mentorId: mentor.id },
        });
      });

      return { mentorName: args.name, mentorPhone: args.phoneNumber };
    },

    async list_reminders(_args, user) {
      const reminders = await prisma.reminder.findMany({
        where: { userPhoneNumber: user.phoneNumber, isActive: true },
        select: {
          medicationName: true,
          reminderTime: true,
          streakCount: true,
        },
      });
      return { reminders };
    },

    async update_reminder(args, user) {
      const active = await prisma.reminder.findMany({
        where: { userPhoneNumber: user.phoneNumber, isActive: true },
      });

      const wantedName = String(args.medicationName || '').toLowerCase();
      const target = active.find(
        (r) =>
          r.medicationName.toLowerCase() === wantedName &&
          r.reminderTime === args.currentTime,
      );

      if (!target) {
        return {
          success: false,
          error: 'No matching active reminder found at that time.',
        };
      }

      const collision = active.find(
        (r) =>
          r.id !== target.id &&
          r.medicationName.toLowerCase() === wantedName &&
          r.reminderTime === args.newTime,
      );

      if (collision) {
        return {
          success: false,
          error: 'A reminder for this medication already exists at the new time.',
        };
      }

      await prisma.reminder.update({
        where: { id: target.id },
        data: { reminderTime: args.newTime },
      });

      return {
        success: true,
        medicationName: target.medicationName,
        oldTime: args.currentTime,
        newTime: args.newTime,
      };
    },

    async cancel_reminder(args, user) {
      const active = await prisma.reminder.findMany({
        where: { userPhoneNumber: user.phoneNumber, isActive: true },
      });

      const wantedName = String(args.medicationName || '').toLowerCase();
      const matches = active.filter(
        (r) =>
          r.medicationName.toLowerCase() === wantedName &&
          (!args.time || r.reminderTime === args.time),
      );

      if (matches.length === 0) {
        return { success: false, error: 'No matching active reminder found.' };
      }

      await prisma.reminder.updateMany({
        where: { id: { in: matches.map((m) => m.id) } },
        data: { isActive: false },
      });

      return {
        success: true,
        cancelled: matches.map((m) => ({
          medicationName: m.medicationName,
          reminderTime: m.reminderTime,
        })),
      };
    },
  };
}
