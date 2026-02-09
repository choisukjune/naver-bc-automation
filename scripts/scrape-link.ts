/**
 * 상품 정보 스크래핑 스크립트
 * 프론트엔드 API에서 호출하여 특정 링크의 정보를 업데이트함
 */

import "dotenv/config";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Page } from "playwright";
import { PrismaClient } from "@prisma/client";
import * as path from "path";
import * as fs from "fs";

chromium.use(StealthPlugin());
const prisma = new PrismaClient();
const SESSION_FILE = path.join(process.cwd(), "playwright", "storage", "naver-session.json");

interface ProductInfo {
    name: string;
    description: string;
    features: string[];
    price: string;
    originalPrice: string;
    discountRate: string;
    couponInfo: string;
    deliveryInfo: string;
    reviewCount: string;
    rating: string;
    storeName: string;
    imageUrls: string[];
}

async function getProductInfo(page: Page, url: string): Promise<ProductInfo> {
    console.log(`🔍 상품 정보 수집 시작: ${url}`);
    await page.goto(url, { timeout: 30000 });
    await page.waitForTimeout(4000);

    // 1. 상품명
    let name = "";
    const nameSelectors = ['._3oDjSvLwEZ', '.product_title', 'h2._22kNQuEXmb', '[class*="product_title"]', '[class*="ProductName"]'];
    for (const s of nameSelectors) {
        const el = await page.$(s);
        if (el) {
            const text = await el.textContent();
            if (text) { name = text.trim(); break; }
        }
    }
    if (!name) name = (await page.title()).split(':')[0].trim();

    // 2. 가격
    let price = "";
    const priceSelectors = ['._1LY7CqmsWw', '.sale_price', '[class*="Price_price"]', '[class*="ProductPrice"]'];
    for (const s of priceSelectors) {
        const el = await page.$(s);
        if (el) {
            const text = await el.textContent();
            if (text) { price = text.trim(); break; }
        }
    }

    // 3. 스토어명
    let storeName = "";
    const storeSelectors = ['.header_brand_name', '._1Snyf7S_84', '.shop_name', '[class*="StoreName"]'];
    for (const s of storeSelectors) {
        const el = await page.$(s);
        if (el) {
            const text = await el.textContent();
            if (text) { storeName = text.trim(); break; }
        }
    }

    // 4. 이미지
    const imageUrls: string[] = [];
    const images = await page.$$('img');
    for (const img of images) {
        let src = await img.getAttribute('src');
        const dataSrc = await img.getAttribute('data-src');
        src = dataSrc || src;
        if (src && (src.includes('shop-phinf.pstatic.net') || src.includes('shopping-phinf.pstatic.net')) && !src.includes('icon') && !src.includes('logo')) {
            const highRes = src.replace(/\?type=.*/, '?type=w860');
            if (!imageUrls.includes(highRes)) imageUrls.push(highRes);
        }
        if (imageUrls.length >= 10) break;
    }

    return {
        name,
        description: "",
        features: [],
        price,
        originalPrice: "",
        discountRate: "",
        couponInfo: "",
        deliveryInfo: "",
        reviewCount: "",
        rating: "",
        storeName,
        imageUrls
    };
}

async function main() {
    const linkId = process.argv[2];
    if (!linkId) {
        console.error("Link ID is required");
        process.exit(1);
    }

    const link = await prisma.brandLink.findUnique({ where: { id: linkId } });
    if (!link) {
        console.error("Link not found");
        process.exit(1);
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined });
    const page = await context.newPage();

    try {
        const info = await getProductInfo(page, link.url);
        await prisma.brandLink.update({
            where: { id: linkId },
            data: {
                productName: info.name,
                productPrice: info.price,
                storeName: info.storeName,
                imageUrls: JSON.stringify(info.imageUrls),
                status: "READY"
            }
        });
        console.log("✅ 상품 정보 업데이트 완료");
    } catch (error) {
        console.error("❌ 스크래핑 오류:", error);
        process.exit(1);
    } finally {
        await browser.close();
        await prisma.$disconnect();
    }
}

main();
