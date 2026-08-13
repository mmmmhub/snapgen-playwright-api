const { chromium } = require('playwright');
const axios = require('axios');

const API_KEY = '1d5b65b9-f2c8-4443-a849-80c9253817e8';
const PAGE_URL = 'https://snapgen.ai';

async function solveTurnstile(page) {
    console.log("جاري البحث عن كود حماية Cloudflare...");
    
    const sitekey = await page.evaluate(() => {
        const turnstileWidget = document.querySelector('.cf-turnstile') || document.querySelector('[data-sitekey]');
        return turnstileWidget ? turnstileWidget.getAttribute('data-sitekey') : '0x4AAAAAAAE-e-o6Q6yv3Zc7';
    });

    console.log(`تم العثور على Sitekey: ${sitekey}. جاري طلب الحل...`);

    try {
        const createUrl = `https://solvercf.com/in.php?key=${API_KEY}&method=turnstile&sitekey=${sitekey}&pageurl=${PAGE_URL}&json=1`;
        const createRes = await axios.get(createUrl);
        
        if (createRes.data.status !== 1) {
            console.log("فشل إنشاء طلب الحل:", createRes.data);
            return false;
        }

        const taskId = createRes.data.request;
        console.log(`تم إرسال الطلب (رقم: ${taskId}). جاري الانتظار للحصول على الحل...`);

        let solution = null;
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 4000));
            const resultUrl = `https://solvercf.com/res.php?key=${API_KEY}&action=get&id=${taskId}&json=1`;
            const resultRes = await axios.get(resultUrl);

            if (resultRes.data.status === 1) {
                solution = resultRes.data.request;
                break;
            }
        }

        if (!solution) {
            console.log("انتهى وقت الانتظار ولم يتم حل الكابتشا.");
            return false;
        }

        console.log("تم استلام الحل! جاري حقنه في الصفحة...");
        
        await page.evaluate((token) => {
            const input = document.querySelector('[name="cf-turnstile-response"]');
            if (input) {
                input.value = token;
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
