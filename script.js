const { chromium } = require('playwright');
const axios = require('axios');

const API_KEY = '1d5b65b9-f2c8-4443-a849-80c9253817e8';
const PAGE_URL = 'https://snapgen.ai';
const SOLVER_BASE_URL = 'https://api.solvercf.com'; // الرابط القياسي المعتمد

async function solveTurnstile(page) {
    console.log("جاري البحث عن كود حماية Cloudflare...");
    
    const sitekey = await page.evaluate(() => {
        const turnstileWidget = document.querySelector('.cf-turnstile') || document.querySelector('[data-sitekey]');
        return turnstileWidget ? turnstileWidget.getAttribute('data-sitekey') : '0x4AAAAAAAE-e-o6Q6yv3Zc7';
    });

    console.log(`تم العثور على Sitekey: ${sitekey}. جاري طلب الحل من SolverCF...`);

    try {
        // 1. إنشاء المهمة (Create Task) بصيغة JSON
        const createRes = await axios.post(`${SOLVER_BASE_URL}/createTask`, {
            clientKey: API_KEY,
            task: {
                type: "TurnstileTaskProxyless",
                websiteURL: PAGE_URL,
                websiteKey: sitekey
            }
        });
        
        if (createRes.data.errorId !== 0) {
            console.log("فشل إنشاء طلب الحل:", createRes.data);
            return false;
        }

        const taskId = createRes.data.taskId;
        console.log(`تم إرسال الطلب (رقم المهمة: ${taskId}). جاري الانتظار...`);

        // 2. سحب النتيجة (Get Task Result)
        let solution = null;
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 3000)); // ننتظر 3 ثواني بين كل محاولة
            
            const resultRes = await axios.post(`${SOLVER_BASE_URL}/getTaskResult`, {
                clientKey: API_KEY,
                taskId: taskId
            });

            if (resultRes.data.errorId === 0) {
                if (resultRes.data.status === 'ready') {
                    solution = resultRes.data.solution.token;
                    break;
                } else if (resultRes.data.status === 'failed') {
                    console.log("فشل العامل في حل الكابتشا.");
                    return false;
                }
            } else {
                console.log("خطأ في جلب النتيجة:", resultRes.data);
                return false;
            }
        }

        if (!solution) {
            console.log("انتهى وقت الانتظار ولم يتم تجهيز الحل.");
            return false;
        }

        console.log("✅ تم استلام الحل! جاري حقنه في الصفحة...");
        
        await page.evaluate((token) => {
            const input = document.querySelector('[name="cf-turnstile-response"]');
            if (input) {
                input.value = token;
            }
            // استدعاء دالة التحقق الخاصة بكلاودفلير إن وجدت في الصفحة
            if (typeof turnstile !== 'undefined' && window.turnstileWidgetId) {
                turnstile.getResponse(window.turnstileWidgetId);
            }
        }, solution);

        return true;

    } catch (error) {
        console.error("خطأ في الاتصال بخدمة الكابتشا:", error.message);
        return false;
    }
}

(async () => {
    console.log("جاري تشغيل المتصفح...");
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();

    try {
        console.log("الدخول إلى موقع SnapGen...");
        await page.goto(PAGE_URL, { waitUntil: 'networkidle' });

        try {
            await page.getByText("Don't show again", { exact: true }).click({ timeout: 3000 });
            console.log("تم إغلاق نافذة الديسكورد.");
        } catch (e) { }

        try {
            await page.getByText("Close and don't show again", { exact: true }).click({ timeout: 3000 });
            console.log("تم إغلاق إشعار الـ API.");
        } catch (e) { }

        await solveTurnstile(page);
        
        await page.waitForTimeout(2000);

        console.log("جاري كتابة البرومبت...");
        await page.getByPlaceholder("Describe the video you want to generate...").fill("A cinematic shot of a futuristic city, highly detailed, 8k resolution");

        console.log("جاري اختيار الأبعاد والجودة...");
        try {
            await page.getByText("16:9").click({ timeout: 2000 });
            await page.getByText("1080p").click({ timeout: 2000 });
        } catch(e) {
            console.log("لم يتم العثور على أزرار الأبعاد/الجودة، سيتم المتابعة بالافتراضي.");
        }

        console.log("الضغط على زر Generate Video...");
        await page.getByRole('button', { name: /Generate Video/i }).click();

        console.log("جاري انتظار توليد الفيديو (قد يستغرق بضع دقائق)...");
        const videoElement = await page.waitForSelector('video', { timeout: 180000 }); 
        const videoUrl = await videoElement.getAttribute('src');

        console.log("✅ تم سحب رابط الفيديو بنجاح:", videoUrl);

    } catch (error) {
        console.error("⚠️ حدث خطأ:", error.message);
    } finally {
        await browser.close();
    }
})();
