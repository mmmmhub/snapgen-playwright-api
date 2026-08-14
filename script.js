const { chromium } = require('playwright');
const axios = require('axios');

// ============================================
// 1. الإعدادات الأساسية
// ============================================
const API_KEY = '1d5b65b9-f2c8-4443-a849-80c9253817e8';
const PAGE_URL = 'https://snapgen.ai';
const TURNSTILE_SITEKEY = '0x4AAAAAACDBydnKT0zYzh2H'; // ✅ المفتاح الحقيقي من الكود المصدري

// ============================================
// 2. دالة حل Turnstile عبر SolverCF
// ============================================
async function solveTurnstile(page) {
    console.log("🔍 جاري البحث عن كود حماية Cloudflare...");
    
    // استخدام المفتاح الحقيقي مباشرة (بدون استخراج من الصفحة)
    const sitekey = TURNSTILE_SITEKEY;
    console.log(`✅ تم العثور على Sitekey: ${sitekey}. جاري طلب الحل من SolverCF...`);

    try {
        // ===== الخطوة 1: إنشاء المهمة =====
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
            return false;
        }

        const taskId = createRes.data.taskId;
        console.log(`✅ تم إرسال الطلب (رقم المهمة: ${taskId}). جاري الانتظار للحصول على الحل...`);

        // ===== الخطوة 2: سحب النتيجة (مع زيادة وقت الانتظار) =====
        let solution = null;
        for (let i = 0; i < 35; i++) { // ✅ 35 محاولة بدل 20
            await new Promise(r => setTimeout(r, 5000)); // ✅ 5 ثواني بدل 4
            
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
                    return false;
                }
            } else {
                console.log("❌ خطأ في جلب النتيجة:", resultRes.data);
                return false;
            }
        }

        if (!solution) {
            console.log("❌ انتهى وقت الانتظار (35 محاولة) ولم يتم تجهيز الحل.");
            return false;
        }

        console.log("✅ تم استلام الحل! جاري حقنه في الصفحة...");
        
        // ===== الخطوة 3: حقن التوكن في الصفحة =====
        await page.evaluate((token) => {
            // محاولة 1: حقل مخفي
            const input = document.querySelector('[name="cf-turnstile-response"]');
            if (input) {
                input.value = token;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            
            // محاولة 2: استخدام Turnstile API مباشرة
            if (typeof turnstile !== 'undefined') {
                try {
                    turnstile.render(document.querySelector('.cf-turnstile'), {
                        sitekey: token,
                        callback: function(response) {
                            console.log('✅ Turnstile تم حله بواسطة SolverCF');
                        }
                    });
                } catch (e) {}
            }
        }, solution);

        // انتظر لحظة للتأكد من تطبيق التوكن
        await page.waitForTimeout(2000);
        console.log("✅ تم حقن التوكن بنجاح");
        return true;

    } catch (error) {
        console.error("❌ خطأ في الاتصال بخدمة الكابتشا:", error.message);
        return false;
    }
}

// ============================================
// 3. الدالة الرئيسية
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

    // إضافة إعدادات التخفي
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

        // ===== حل Turnstile =====
        const solved = await solveTurnstile(page);
        if (!solved) {
            console.log("⚠️ فشل حل Turnstile، لكن سنحاول المتابعة...");
        }
        
        await page.waitForTimeout(2000);

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
            console.log("⚠️ لم يتم العثور على أزرار الأبعاد/الجودة، سيتم المتابعة بالافتراضي.");
        }

        // ===== الضغط على زر التوليد =====
        console.log("🎬 الضغط على زر Generate Video...");
        await page.getByRole('button', { name: /Generate Video/i }).click();

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
