const { chromium } = require('playwright');
const axios = require('axios');

// ============================================
// 1. المفاتيح
// ============================================
const API_KEY = '1d5b65b9-f2c8-4443-a849-80c9253817e8';
const PAGE_URL = 'https://snapgen.ai';
const TURNSTILE_SITEKEY = '0x4AAAAAACDBydnKT0zYzh2H';

// ============================================
// 2. دالة حل Turnstile (قابلة لإعادة الاستخدام)
// ============================================
async function solveTurnstile(page, sitekey = TURNSTILE_SITEKEY) {
    console.log("🔍 جاري طلب حل Turnstile من SolverCF...");
    
    try {
        // إنشاء المهمة
        const createRes = await axios.post('https://solvercf.com/token/extension/createTask', {
            clientKey: API_KEY,
            task: {
                type: "TurnstileTask",
                websiteUrl: PAGE_URL,
                websiteKey: sitekey
            }
        });
        
        if (createRes.data.errorId !== 0) {
            console.log("❌ فشل إنشاء طلب الحل:", createRes.data);
            return null;
        }

        const taskId = createRes.data.taskId;
        console.log(`✅ تم إرسال الطلب (رقم: ${taskId}). جاري الانتظار...`);

        // سحب النتيجة (35 محاولة × 5 ثواني = 175 ثانية كحد أقصى)
        let solution = null;
        for (let i = 0; i < 35; i++) {
            await new Promise(r => setTimeout(r, 5000));
            
            const resultRes = await axios.post('https://solvercf.com/token/extension/getTaskResult', {
                clientKey: API_KEY,
                taskId: taskId
            });

            if (resultRes.data.errorId === 0) {
                if (resultRes.data.status === 'ready') {
                    solution = resultRes.data.solution.token;
                    console.log(`✅ تم الحل بعد ${i+1} محاولة`);
                    break;
                } else if (resultRes.data.status === 'failed') {
                    console.log("❌ فشل العامل في حل الكابتشا.");
                    return null;
                }
            }
        }

        if (!solution) {
            console.log("❌ انتهى الوقت ولم يتم تجهيز الحل.");
            return null;
        }

        console.log("✅ تم استلام الحل! جاري حقنه في الصفحة...");
        
        // حقن التوكن في الصفحة
        await page.evaluate((token) => {
            // الطريقة 1: حقل مخفي
            const input = document.querySelector('[name="cf-turnstile-response"]');
            if (input) {
                input.value = token;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            
            // الطريقة 2: استخدام Turnstile API
            if (typeof turnstile !== 'undefined') {
                try {
                    const widget = document.querySelector('.cf-turnstile');
                    if (widget) {
                        turnstile.render(widget, {
                            sitekey: token,
                            callback: function(response) {
                                console.log('✅ Turnstile تم حله');
                            }
                        });
                    }
                } catch (e) {}
            }
        }, solution);

        await page.waitForTimeout(2000);
        return solution;

    } catch (error) {
        console.error("❌ خطأ في الاتصال بخدمة الكابتشا:", error.message);
        return null;
    }
}

// ============================================
// 3. دالة للتعامل مع Turnstile عند ظهوره
// ============================================
async function handleTurnstileIfAppears(page) {
    try {
        // انتظر ظهور Turnstile (iframe أو العنصر)
        const turnstileFrame = await page.waitForSelector(
            'iframe[src*="challenges.cloudflare.com"], .cf-turnstile',
            { timeout: 10000 }
        );
        
        if (turnstileFrame) {
            console.log("🔄 تم اكتشاف Turnstile جديد، جاري حله...");
            const token = await solveTurnstile(page);
            if (token) {
                console.log("✅ تم حل Turnstile الجديد بنجاح");
                return true;
            }
        }
        return false;
    } catch (e) {
        // لا يوجد Turnstile (مطلوب)
        return true;
    }
}

// ============================================
// 4. الدالة الرئيسية
// ============================================
(async () => {
    console.log("🚀 جاري تشغيل المتصفح...");
    const browser = await chromium.launch({ 
        headless: true, 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ] 
    });
    const page = await browser.newPage();

    // إعدادات التخفي
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    try {
        console.log("🌐 الدخول إلى موقع SnapGen...");
        await page.goto(PAGE_URL, { waitUntil: 'networkidle' });

        // إغلاق النوافذ المنبثقة
        try {
            await page.getByText("Don't show again", { exact: true }).click({ timeout: 3000 });
            console.log("✅ تم إغلاق نافذة الديسكورد.");
        } catch (e) { }

        try {
            await page.getByText("Close and don't show again", { exact: true }).click({ timeout: 3000 });
            console.log("✅ تم إغلاق إشعار الـ API.");
        } catch (e) { }

        // ===== حل Turnstile الأول (عند تحميل الصفحة) =====
        console.log("🔄 حل Turnstile الأول...");
        await handleTurnstileIfAppears(page);

        // ===== كتابة البرومبت =====
        console.log("✍️ جاري كتابة البرومبت...");
        await page.getByPlaceholder("Describe the video you want to generate...").fill(
            "A cinematic shot of a futuristic city, highly detailed, 8k resolution"
        );

        // ===== اختيار الأبعاد والجودة =====
        console.log("📐 جاري اختيار الأبعاد والجودة...");
        try {
            await page.getByText("16:9").click({ timeout: 2000 });
            await page.getByText("1080p").click({ timeout: 2000 });
        } catch(e) {
            console.log("⚠️ لم يتم العثور على أزرار الأبعاد/الجودة.");
        }

        // ===== الضغط على زر التوليد =====
        console.log("🎬 الضغط على زر Generate Video...");
        await page.getByRole('button', { name: /Generate Video/i }).click();

        // ===== حل Turnstile الثاني (الذي يظهر بعد الضغط على الزر) =====
        console.log("🔄 انتظار ظهور Turnstile الثاني وحله...");
        await handleTurnstileIfAppears(page);

        // ===== انتظار توليد الفيديو =====
        console.log("⏳ جاري انتظار توليد الفيديو (قد يستغرق حتى 4 دقائق)...");
        const videoElement = await page.waitForSelector('video', { timeout: 240000 }); 
        const videoUrl = await videoElement.getAttribute('src');

        console.log("✅ تم سحب رابط الفيديو بنجاح:", videoUrl);

    } catch (error) {
        console.error("⚠️ حدث خطأ:", error.message);
    } finally {
        await browser.close();
        console.log("🔚 تم إغلاق المتصفح.");
    }
})();
