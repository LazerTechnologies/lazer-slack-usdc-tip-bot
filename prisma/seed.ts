import { PrismaClient } from "../src/generated";

const db = new PrismaClient();

const main = async () => {
    const settings = await db.settings.findFirst();
    if(settings){
        console.log("Settings already exist, skipping seed.");
        process.exit(0);
    }
    
    await db.settings.create({
        data: {
            dailyFreeTipAmount: 10, // 10 free tips per day
            tipAmount: 0.01, // 0.01 USDC per tip
        }
    })
}


main();