import prisma from "./prismaClient.ts";

const admins = process.env.BOT_ADMINS?.split(',') || [];

if(admins.length === 0) {
    console.error("No BOT_ADMINS found in environment variables.");
} else {
    await prisma.settings.update({
        where: { id: 1 },
        data: {
            adminSlackIds: admins
        }
    })

    console.log("Updated admin Slack IDs:", admins);
}


