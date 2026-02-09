/**
 * 심플 에이전트 - 단순하게 동작하는 버전
 * 한 단계씩 확인하며 진행
 */

import "dotenv/config";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Page } from "playwright";
import { PrismaClient } from "@prisma/client";
import * as path from "path";
import * as fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { marked } from "marked";

// Stealth 플러그인 적용 (봇 감지 우회)
chromium.use(StealthPlugin());

const prisma = new PrismaClient();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({
  model: "gemini-3-flash-preview",
  generationConfig: {
    responseMimeType: "application/json",
  }
});

const SESSION_FILE = path.join(process.cwd(), "playwright", "storage", "naver-session.json");
const TEMP_PATH = path.join(process.cwd(), "temp_images");
const NAVER_BLOG_ID = process.env.NAVER_BLOG_ID || "";

if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH, { recursive: true });

// ============================================
// STEP 1: 상품 페이지에서 상품 정보 + 이미지 추출
// ============================================
interface ProductInfo {
  name: string;
  description: string;
  features: string[];
  price: string;
  originalPrice: string;      // 원가 (할인 전 가격)
  discountRate: string;       // 할인율 (예: "30%")
  couponInfo: string;         // 쿠폰 정보
  deliveryInfo: string;       // 배송 정보 (무료배송 등)
  reviewCount: string;        // 리뷰 수
  rating: string;             // 평점
  storeName: string;          // 스토어명
  imagePaths: string[];
}

async function step1_getProductInfo(page: Page, url: string): Promise<ProductInfo> {
  console.log("\n📦 STEP 1: 상품 정보 수집");

  await page.goto(url, { timeout: 30000 });
  await page.waitForTimeout(5000);

  // 1. 상품명 추출 (여러 방법 시도)
  let productName = "";

  // og:title에서 추출
  const ogTitle = await page.$('meta[property="og:title"]');
  if (ogTitle) {
    const content = await ogTitle.getAttribute('content');
    if (content) productName = content.split(':')[0].split('-')[0].trim();
  }

  // 페이지 내 상품명 요소에서 추출 (더 정확)
  const nameSelectors = [
    '._3oDjSvLwEZ',           // 스마트스토어 상품명
    '.product_title',
    'h2._22kNQuEXmb',
    '[class*="product_title"]',
    '[class*="ProductName"]',
  ];

  for (const selector of nameSelectors) {
    const el = await page.$(selector);
    if (el) {
      const text = await el.textContent();
      if (text && text.length > 3) {
        productName = text.trim();
        break;
      }
    }
  }

  if (!productName) {
    productName = (await page.title()).split(':')[0].split('-')[0].trim();
  }
  console.log(`   📌 상품명: ${productName}`);

  // 2. 상품 설명 추출
  let description = "";
  const descSelectors = [
    '._1s2eOHMQjt',           // 스마트스토어 상품 설명
    '.product_detail_description',
    '[class*="description"]',
    'meta[property="og:description"]',
  ];

  for (const selector of descSelectors) {
    if (selector.startsWith('meta')) {
      const meta = await page.$(selector);
      if (meta) {
        description = await meta.getAttribute('content') || "";
        break;
      }
    } else {
      const el = await page.$(selector);
      if (el) {
        description = (await el.textContent())?.trim() || "";
        if (description.length > 10) break;
      }
    }
  }
  console.log(`   📝 설명: ${description.substring(0, 50)}...`);

  // 3. 상품 특징/키워드 추출
  const features: string[] = [];
  const featureEls = await page.$$('[class*="benefit"], [class*="feature"], [class*="spec"] li');
  for (const el of featureEls.slice(0, 5)) {
    const text = await el.textContent();
    if (text && text.length > 3 && text.length < 50) {
      features.push(text.trim());
    }
  }
  console.log(`   ✨ 특징: ${features.length}개`);

  // 4. 가격 추출
  let price = "";
  const priceSelectors = ['._1LY7DqCnwR', '.total_price', '[class*="price"]:not([class*="original"])'];
  for (const selector of priceSelectors) {
    const el = await page.$(selector);
    if (el) {
      price = (await el.textContent())?.trim() || "";
      if (price.includes('원')) break;
    }
  }
  console.log(`   💰 가격: ${price}`);

  // 4-1. 원가 (할인 전 가격) 추출
  let originalPrice = "";
  const originalPriceSelectors = [
    'del', 'strike',
    '[class*="original"]', '[class*="before"]',
    '._2DywKu0J_Y',  // 스마트스토어 원가
    '.price_del'
  ];
  for (const selector of originalPriceSelectors) {
    const el = await page.$(selector);
    if (el) {
      const text = (await el.textContent())?.trim() || "";
      if (text.includes('원') || /[\d,]+/.test(text)) {
        originalPrice = text;
        break;
      }
    }
  }
  if (originalPrice) console.log(`   💸 원가: ${originalPrice}`);

  // 4-2. 할인율 추출
  let discountRate = "";
  const discountSelectors = [
    '[class*="discount"]', '[class*="sale"]',
    '._2pgHN-ntx6',  // 스마트스토어 할인율
    '.discount_rate', '[class*="percent"]'
  ];
  for (const selector of discountSelectors) {
    const el = await page.$(selector);
    if (el) {
      const text = (await el.textContent())?.trim() || "";
      if (text.includes('%')) {
        discountRate = text.match(/\d+%/)?.[0] || text;
        break;
      }
    }
  }
  if (discountRate) console.log(`   🔥 할인율: ${discountRate}`);

  // 4-3. 쿠폰/혜택 정보 추출
  let couponInfo = "";
  const couponSelectors = [
    '[class*="coupon"]', '[class*="benefit"]',
    '[class*="naver_point"]', '[class*="npay"]',
    '._1zItxZRrZt',  // 스마트스토어 쿠폰
    '.benefit_info'
  ];
  const couponTexts: string[] = [];
  for (const selector of couponSelectors) {
    const els = await page.$$(selector);
    for (const el of els.slice(0, 3)) {
      const text = (await el.textContent())?.trim() || "";
      if (text && text.length > 2 && text.length < 100 && !couponTexts.includes(text)) {
        couponTexts.push(text);
      }
    }
  }
  couponInfo = couponTexts.join(' / ');
  if (couponInfo) console.log(`   🎁 쿠폰/혜택: ${couponInfo.substring(0, 50)}...`);

  // 4-4. 배송 정보 추출
  let deliveryInfo = "";
  const deliverySelectors = [
    '[class*="delivery"]', '[class*="shipping"]',
    '._2OAJPEG1R8',  // 스마트스토어 배송
    '.delivery_fee_info'
  ];
  for (const selector of deliverySelectors) {
    const el = await page.$(selector);
    if (el) {
      const text = (await el.textContent())?.trim() || "";
      if (text && (text.includes('배송') || text.includes('무료') || text.includes('도착'))) {
        deliveryInfo = text.replace(/\s+/g, ' ').substring(0, 50);
        break;
      }
    }
  }
  if (deliveryInfo) console.log(`   🚚 배송: ${deliveryInfo}`);

  // 4-5. 리뷰 수 & 평점 추출
  let reviewCount = "";
  let rating = "";
  const reviewSelectors = [
    '[class*="review"]', '[class*="rating"]',
    '._2LvUD5PAiM',  // 스마트스토어 리뷰
    '.review_count'
  ];
  for (const selector of reviewSelectors) {
    const el = await page.$(selector);
    if (el) {
      const text = (await el.textContent())?.trim() || "";
      // 리뷰 수 추출 (숫자가 포함된 경우)
      const countMatch = text.match(/[\d,]+(?=\s*개|\s*건)?/);
      if (countMatch && !reviewCount) {
        reviewCount = countMatch[0];
      }
      // 평점 추출 (4.8 같은 형태)
      const ratingMatch = text.match(/\d\.\d/);
      if (ratingMatch && !rating) {
        rating = ratingMatch[0];
      }
    }
  }
  if (reviewCount) console.log(`   ⭐ 리뷰: ${reviewCount}개`);
  if (rating) console.log(`   ⭐ 평점: ${rating}`);

  // 5. 상품 이미지 URL 추출
  console.log("   🖼️ 이미지 URL 추출 중...");
  const imageUrls: string[] = [];

  const images = await page.$$('img');
  for (const img of images) {
    let src = await img.getAttribute('src');
    const dataSrc = await img.getAttribute('data-src');
    src = dataSrc || src;

    if (src &&
      (src.includes('shop-phinf.pstatic.net') || src.includes('shopping-phinf.pstatic.net')) &&
      !src.includes('icon') && !src.includes('logo') && !src.includes('1x1')) {
      const highRes = src.replace(/\?type=.*/, '?type=w860');
      if (!imageUrls.includes(highRes)) {
        imageUrls.push(highRes);
      }
    }
    if (imageUrls.length >= 15) break;  // 더 많이 수집
  }

  console.log(`   🖼️ ${imageUrls.length}개 이미지 발견`);

  // 이미지 다운로드 (최대 10개로 확대)
  const imagePaths: string[] = [];
  const downloadCount = Math.min(10, imageUrls.length);

  for (let i = 1; i < downloadCount; i++) {
    try {
      const imgPath = path.join(TEMP_PATH, `product_${Date.now()}_${i}.jpg`);
      await downloadImage(imageUrls[i], imgPath);
      imagePaths.push(imgPath);
      console.log(`   ✅ 이미지 ${i + 1}/${downloadCount} 다운로드`);
    } catch (e) {
      console.log(`   ⚠️ 다운로드 실패 ${i + 1}`);
    }
  }

  // 스토어명 추출 시도
  let storeName = "";
  const storeNameSelectors = [
    '.header_brand_name',
    '._1Snyf7S_84',
    '.shop_name',
    '[class*="StoreName"]',
  ];
  for (const selector of storeNameSelectors) {
    const el = await page.$(selector);
    if (el) {
      const text = await el.textContent();
      if (text) {
        storeName = text.trim();
        break;
      }
    }
  }

  return {
    name: productName,
    description,
    features,
    price,
    originalPrice,
    discountRate,
    couponInfo,
    deliveryInfo,
    reviewCount,
    rating: rating,
    storeName,
    imagePaths,
  };
}

// 이미지 다운로드 함수
async function downloadImage(url: string, filePath: string): Promise<void> {
  const https = await import('https');
  const http = await import('http');

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(filePath);

    protocol.get(url, (response: any) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          downloadImage(redirectUrl, filePath).then(resolve).catch(reject);
          return;
        }
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err: any) => {
      fs.unlink(filePath, () => { });
      reject(err);
    });
  });
}

// ============================================
// STEP 2: LLM으로 SEO 최적화 글 생성 (긴 버전)
// ============================================
// ============================================
// ============================================
// STEP 1.5: SEO 최적화 정보 분석
// ============================================
async function step1_5_seoAnalysis(product: ProductInfo): Promise<string> {
  console.log("\n🔍 STEP 1.5: SEO 키워드 및 경쟁 글 분석 중...");

  const prompt = `아래 주제에 대해 네이버 블로그 SEO 최적화를 위한 정보를 상세히 분석해줘.
- 주제: ${product.name}
- 상품 설명: ${product.description || "정보 없음"}

분석 결과에는 다음 장치들이 포함되어야 합니다:
1. 네이버 상위 랭크를 위한 제목 패턴 추천 (3가지)
1-1. 글을 읽는 사람은 무조건 구매욕구를 불러일으켜야한다.
2. 본문에 반드시 포함해야 할 '메인 키워드'와 '서브 키워드' (각 5개 이상)
3. 경쟁 글들과 차별화할 수 있는 이 제품만의 검색 소구점
4. 추천 해시태그 조합 (15~20개)

이 정보는 다음 단계에서 글을 쓸 때 가이드라인으로 활용될 것입니다.`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}

// ============================================
// STEP 2: SEO 최적화 글 생성 (스토리텔링 & 리스트형 분석)
// ============================================
async function step2_generatePost(product: ProductInfo, brandLink: string, seoContext: string, disclosureImageUrl: string = ""): Promise<{ title: string; sections: string[]; hashtags: string[] }> {
  console.log("\n📝 STEP 2: SEO 최적화 블로그 글 생성 (슬기로운 리뷰생활 스타일)");

  // 섹션 수 확보 (최소 5개 구조 유지)
  // 구조가 고정적이므로 이미지는 적절히 분배하여 사용하도록 유도

  const prompt = `당신은 꼼꼼하고 논리적인 '슬기로운 리뷰어' 페르소나를 가진 블로거입니다.
아래 상품에 대해 소비자가 흔히 겪는 '실패 경험'을 정리하고,
객관적인 비교와 표(Table)를 통해 **신뢰감 있게 제품을 소개하는 고품질 리뷰**를 작성해주세요.

⚠️ 개인 일기형 후기나 과도한 1인칭 체험담이 아니라,
'검증된 선택지로서 왜 이 제품이 합리적인가'를 설명하는 정보형 리뷰에 가깝게 작성합니다.

## 상품 정보
- 상품명: ${product.name}
- 설명: ${product.description || '(상품 설명 참고)'}
- 특징: ${product.features.join(', ') || '(상품 특징 참고)'}
- 가격: ${product.price || '(가격 정보 참고)'}
${product.originalPrice ? `- 원가: ${product.originalPrice}` : ''}
${product.discountRate ? `- 할인율: ${product.discountRate} 할인 중!` : ''}
${product.reviewCount ? `- 리뷰: ${product.reviewCount}개` : ''}

## SEO 분석 가이드 (이 내용을 반드시 반영하세요)
${seoContext}

## 글의 톤앤매너
- **어조**: 차분한 설명형 경어체  
  (예: "~하는 분들이 많습니다", "~한 선택지가 필요해집니다", "이런 점에서 차이가 납니다")
- **핵심 전략**:
  - 무조건 좋다고 주장하지 않음
  - 소비자가 흔히 실패하는 지점을 먼저 정리
  - ${product.name}이 그 문제를 **어떻게 구조적으로 해결하는지**를 논리적으로 설명
- **포맷팅**: 가독성을 위해 **Markdown Table** 적극 활용
- **주의 사항**:
  1. 'OOO', 'XXX', '---', 'OO 상품' 같은 플레이스홀더 절대 사용 금지
  2. 모든 체크리스트(✅)는 반드시 한 줄에 하나씩 작성하고 줄 끝에 '\\n\\n' 추가
  3. 제품명은 반드시 "${product.name}" 그대로 사용
  4. 감정 과잉·후기체 문장은 지양하고, 설명·비교·정리 중심으로 작성

## 필수 포함 구조 (총 5개 섹션, 순서 엄수)

1. **인트로: 반복되는 실패 패턴**
   - 기존 방식이나 유사 제품에서 자주 발생하는 불편함을 질문형으로 제시
   - "왜 정착하지 못하는지" 구조적으로 정리
   - 그 대안으로 ${product.name}이 어떤 위치의 제품인지 요약

2. **선택 기준과 비교 분석 (표 포함)**
   - 소비자가 흔히 겪는 실패 사례 정리 (가격 대비 성능, 번거로움 등)
   - 제품 선택 시 중요하게 봐야 할 기준 2~3가지 제시
   - **[필수] 비교 분석 표 작성**
     | 구분 | 일반/기존 제품 | ${product.name} |
     |---|---|---|
     | 항목1 | | |
     | 항목2 | | |
     | 항목3 | | |

3. **사용 환경별 활용 가치**
   - **일상적인 상황**: 바쁜 생활 속에서 어떤 점이 간편해지는지
   - **특정 상황**: 여행, 외출, 계절적 고민 등에서의 활용성
   - 체감 변화는 감각적으로 표현하되, 개인 감정 과잉은 피할 것

4. **장단점 정리 및 판단 기준 (표 포함)**
   - "완벽한 제품은 없다"는 전제로 시작
   - **[필수] 장단점 & 보완 포인트 표**
     | 유형 | 내용 | 해결방안 |
     |---|---|---|
     | 장점 | | |
     | 장점 | | |
     | 단점 | | |
   - 단점은 현실적으로 인정하되, 구매 판단에 어떤 의미인지 설명
   - 전체적으로는 장점이 더 크게 작용한다는 논리적 정리

5. **추천 대상 정리**
   - "이 제품이 잘 맞는 유형" 중심으로 체크리스트 구성
   - 꾸준히 사용하기 좋은 조건과 관리 부담까지 언급하며 마무리

## 출력 형식 (JSON Only)
**주의**: JSON 문자열 내 줄바꿈은 반드시 '\\n' 사용
{
  "title": "상품명 + 선택 기준이 명확해지는 한 줄 요약",
  "sections": [
    "인트로 소제목\\n\\n본문...",
    "선택 기준 소제목\\n\\n본문...\\n\\n| 구분 | 일반 제품 | ${product.name} |\\n|---|---|---|\\n| ... | ... | ... |",
    "활용 가치 소제목\\n\\n본문...",
    "장단점 정리 소제목\\n\\n본문...\\n\\n| 유형 | 내용 | 해결방안 |\\n|---|---|---|\\n| 장점 | | |\\n| 단점 | | |",
    "추천 대상\\n\\n✅ 체크 항목\\n\\n..."
  ],
  "hashtags": ["#핵심키워드", "#구매가이드", "#제품비교"]
}`;

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: `당신은 전문적인 제품 리뷰어입니다. 
1. JSON 포맷을 엄격히 지키세요. 
2. 본문 내용에 Markdown Table을 포함할 때 줄바꿈 처리에 유의하세요.
3. 절대 'OOO', 'XXX' 같은 플레이스홀더를 남기지 마세요. 100% 문장을 완성하세요.
4. 모든 체크리스트(✅) 아이템은 반드시 한 줄에 하나씩 쓰고 뒤에 '\\n\\n'을 붙여 시각적으로 분리하세요.
5. 모든 비유나 설명은 "${product.name}"에 맞춰서 구체적으로 작성하세요.
6. 독자가 신뢰할 수 있도록 너무 과장된 칭찬보다는 구체적인 경험과 논리적인 표를 중심으로 작성하세요.`,
  });

  const text = result.response.text();
  let json;
  try {
    // 1. 기본 매칭 시도 (```json ... ``` 또는 ``` ... ```)
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const contentToParse = jsonMatch ? jsonMatch[1].trim() : text.trim();

    // 2. 혹시나 있을 제어 문자 제거 (JSON.parse 에러 방지)
    const sanitizedContent = contentToParse.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

    json = JSON.parse(sanitizedContent);
  } catch (e) {
    console.error("❌ [STEP 2] JSON Parsing Error:", e);
    console.error("📄 [STEP 2] Raw Response:", text);

    // 3. 마지막 수단: { } 사이의 내용만 추출 시도
    try {
      const braceMatch = text.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        json = JSON.parse(braceMatch[0]);
      } else {
        throw new Error("No JSON structure found");
      }
    } catch (innerE) {
      console.error("❌ [STEP 2] Secondary Parsing Failed:", innerE);
      json = {
        title: `${product.name} 솔직 리뷰`,
        sections: ["죄송합니다. 글 생성 중 오류가 발생했습니다. (JSON 파싱 실패)"],
        hashtags: []
      };
    }
  }

  // ✅ 1. 상단 공정위 문구 (이미지) 추가 로직
  // 이미지가 있으면 이미지 태그로, 없으면 텍스트로 대체
  // const topDisclosureSection = disclosureImageUrl
  //   ? `![소정의 수수료를 제공받을 수 있습니다](${disclosureImageUrl})\n\n`
  //   : `*(본 포스팅은 소정의 원고료/수수료를 제공받을 수 있습니다)*\n\n`;

  // ✅ 2. 하단 공정위 문구 및 링크 추가
  // ✅ 2. 하단 공정위 문구 및 링크 추가
  const lastSection = `
이 포스팅은 네이버 쇼핑 커넥트 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받을 수 있습니다.
👉 최저가 확인하기: ${brandLink}`;

  // 섹션 조립: [상단 이미지] + [생성된 본문] + [하단 링크]
  const sections = json.sections || [""];

  // 1. 하단 링크 추가 (맨 뒤)
  sections.push(lastSection);

  // 3. 상단 공정위 문구 추가 (맨 앞)
  //sections.unshift(topDisclosureSection);

  const totalLength = sections.reduce((sum: number, s: string) => sum + s.length, 0);
  console.log(`   📌 제목: ${json.title}`);
  console.log(`   📝 섹션: ${sections.length}개, 총 ${totalLength}자`);

  return {
    title: json.title || product.name,
    sections: sections,
    hashtags: json.hashtags || []
  };
}

// ============================================
// STEP 2.5: 썸네일 기획 (프롬프트 & 타이틀 생성)
// ============================================
async function step2_5_planThumbnail(product: ProductInfo, post: { title: string; sections: string[] }): Promise<{ prompts: string[]; titles: { main: string; sub: string }[] }> {
  console.log("\n📸 STEP 2.5: 썸네일 기획 생성 중...");

  const prompt = `당신은 마케팅 전문가이자 AI 이미지 생성 프롬프트 엔지니어입니다.
방금 작성된 블로그 리뷰(${post.title})를 바탕으로, 네이버 블로그 썸네일을 위한 '나노 바나나프로' 합성 프롬프트와 타이틀을 기획해주세요.

## 상품명: ${product.name}
## 브랜드: ${product.storeName || "(정보 없음)"}

## 기획 가이드
1. 나노 바나나프로(AI 이미지 생성 도구) 전용 합성 프롬프트:
   - 상품이 돋보일 수 있는 배경, 조명, 구도(Perspective), 재질감을 상세히 묘사하세요.
   - 영어 프롬프트로 작성해주세요. (3개)
2. 썸네일 타이틀:
   - 독자의 클릭을 유도할 수 있는 매력적인 메인 타이틀과 이를 보조하는 서브 타이틀을 작성해주세요. (3세트)

## 출력 형식 (JSON)
{
  "prompts": ["Prompt 1...", "Prompt 2...", "Prompt 3..."],
  "titles": [
    { "main": "메인 타이틀 1", "sub": "서브 타이틀 1" },
    { "main": "메인 타이틀 2", "sub": "서브 타이틀 2" },
    { "main": "메인 타이틀 3", "sub": "서브 타이틀 3" }
  ]
}
`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  try {
    // 1. 기본 매칭 시도 (```json ... ``` 또는 ``` ... ```)
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const contentToParse = jsonMatch ? jsonMatch[1].trim() : text.trim();

    // 2. 혹시나 있을 제어 문자 제거
    const sanitizedContent = contentToParse.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

    return JSON.parse(sanitizedContent);
  } catch (e) {
    console.error("❌ [STEP 2.5] JSON Parsing Error:", e);
    console.error("📄 [STEP 2.5] Raw Response:", text);

    // 3. 마지막 수단: { } 사이의 내용만 추출 시도
    try {
      const braceMatch = text.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        return JSON.parse(braceMatch[0]);
      }
    } catch (innerE) {
      console.error("❌ [STEP 2.5] Secondary Parsing Failed:", innerE);
    }

    return {
      prompts: ["Photo of " + product.name + " on a clean desk, soft lighting, 8k, professional photography"],
      titles: [{ main: product.name + " 솔직후기", sub: "직접 써본 리얼 리뷰" }]
    };
  }
}

// ============================================
// STEP 3: 블로그 에디터 열기
// ============================================
async function step3_openEditor(page: Page): Promise<void> {
  console.log("\n📄 STEP 3: 블로그 글쓰기 페이지");

  await page.goto(`https://blog.naver.com/${NAVER_BLOG_ID}/postwrite`, { timeout: 30000 });
  await page.waitForTimeout(5000);

  // 팝업 닫기 (작성 중인 글 있습니다)
  try {
    const cancelBtn = await page.$('.se-popup-button-cancel');
    if (cancelBtn) {
      await cancelBtn.click();
      console.log("   팝업 닫음");
      await page.waitForTimeout(1000);
    }
  } catch { }

  console.log("   ✅ 에디터 준비 완료");
}

// ============================================
// STEP 4: 제목 입력
// ============================================
async function step4_inputTitle(page: Page, title: string): Promise<void> {
  console.log("\n✏️ STEP 4: 제목 입력");

  // 제목 영역 클릭
  const titleArea = await page.$('.se-documentTitle .se-text-paragraph');
  if (titleArea) {
    await titleArea.click();
    await page.waitForTimeout(300);
  } else {
    // 좌표로 클릭 (제목 위치)
    await page.mouse.click(640, 130);
    await page.waitForTimeout(300);
  }

  await page.keyboard.type(title, { delay: 30 });
  console.log(`   ✅ 제목 입력: "${title}"`);
}

// ============================================
// STEP 5: 이미지 1장 업로드 (반복 호출용)
// ============================================
async function uploadOneImage(page: Page, imagePath: string): Promise<boolean> {
  try {
    const imageBtn = await page.$('button[data-name="image"]');
    if (imageBtn) {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
        imageBtn.click()
      ]);

      if (fileChooser) {
        await fileChooser.setFiles(imagePath);
        await page.waitForTimeout(2500); // 업로드 완료 대기
        return true;
      }
    }
  } catch (e) {
    console.log(`   ⚠️ 업로드 실패: ${e}`);
  }
  return false;
}

// 텍스트 섹션 입력 (소제목 타이핑 + 본문 HTML 붙여넣기 혼합 방식)
async function inputTextSection(page: Page, text: string): Promise<void> {
  // 1. 첫 줄(소제목)과 나머지 본문 분리
  const lines = text.split('\n');
  const firstLine = lines[0]?.trim() || "";
  const remainingText = lines.slice(1).join('\n').trim();

  console.log(`   📝 섹션 입력 중: ${firstLine.slice(0, 20)}...`);

  // 1. 첫 줄(소제목)을 위해 '소제목' 서식 선택 후 타이핑
  if (firstLine) {
    try {
      const formatBtn = await page.$('button[data-name="text-format"]');
      if (formatBtn) {
        await formatBtn.click();
        await page.waitForTimeout(600);
        const subheadingBtn = await page.$('button[data-value="sectionTitle"]');
        if (subheadingBtn) {
          await subheadingBtn.click();
          await page.waitForTimeout(600);
          await page.keyboard.type(firstLine, { delay: 15 });
          await page.keyboard.press('Enter');
          await page.waitForTimeout(500);
        }
      }
    } catch (e) {
      console.log("   ⚠️ 소제목 서식 적용 실패, 일반 텍스트로 진행");
      await page.keyboard.type(firstLine, { delay: 10 });
      await page.keyboard.press('Enter');
    }
  }

  // 2. 나머지 본문은 HTML로 변환하여 붙여넣기 (속도와 서식 유지)
  if (remainingText) {
    const htmlContent = `
      <div style="font-size: 16px; line-height: 1.8;">
        ${marked.parse(remainingText)}
      </div>
    `;

    await page.evaluate(async (html) => {
      const listener = (e: ClipboardEvent) => {
        if (e.clipboardData) {
          e.clipboardData.setData('text/html', html);
          e.clipboardData.setData('text/plain', html.replace(/<[^>]*>/g, ''));
        }
        e.preventDefault();
      };
      document.addEventListener('copy', listener);
      document.execCommand('copy');
      document.removeEventListener('copy', listener);
    }, htmlContent);

    // 4. 붙여넣기 단축키 실행 (OS에 따라 분기)
    const isMac = process.platform === 'darwin';
    const modifier = isMac ? 'Meta' : 'Control';

    await page.keyboard.press(`${modifier}+v`);
    await page.waitForTimeout(800); // 붙여넣기 처리 대기

    // 5. 다음 섹션을 위한 여백 (엔터 두 번)
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
  }
}

// 텍스트 섹션 입력 (직접 타이핑 방식 - 링크 카드 생성을 위해 사용)
async function typeTextSection(page: Page, text: string): Promise<void> {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      await page.keyboard.type(trimmed, { delay: 10 });
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
  }
}

// 구분선(hr) 붙여넣기
async function pasteHorizontalRule(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const html = '<hr class="se-hr">';
    const listener = (e: ClipboardEvent) => {
      if (e.clipboardData) {
        e.clipboardData.setData('text/html', html);
        e.clipboardData.setData('text/plain', '---');
      }
      e.preventDefault();
    };
    document.addEventListener('copy', listener);
    document.execCommand('copy');
    document.removeEventListener('copy', listener);
  });
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+v`);
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}

// ============================================
// STEP 5+6: 이미지와 본문 번갈아 입력
// ============================================
async function step5and6_uploadAndWrite(page: Page, imagePaths: string[], sections: string[], hashtags: string[]): Promise<void> {
  console.log("\n📝 STEP 5+6: 이미지 + 본문 번갈아 입력");

  // 본문 영역으로 이동
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);

  const maxLoop = Math.max(imagePaths.length, sections.length);
  let uploadedCount = 0;

  for (let i = 0; i < maxLoop; i++) {
    // 이미지 업로드 (있으면)
    if (i < imagePaths.length) {
      console.log(`   [${i + 1}] 🖼️ 이미지 업로드...`);
      const success = await uploadOneImage(page, imagePaths[i]);
      if (success) uploadedCount++;
    }

    // 텍스트 섹션 입력 (있으면)
    if (i < sections.length) {
      const isLast = i === sections.length - 1;
      console.log(`   [${i + 1}] ✏️ 텍스트 입력 (${sections[i].length}자) ${isLast ? '(타이핑)' : '(붙여넣기)'}`);

      if (isLast) {
        // 마지막 섹션(링크)은 링크 카드 생성을 위해 직접 타이핑
        await typeTextSection(page, sections[i]);
      } else {
        await inputTextSection(page, sections[i]);
      }

      // 섹션 끝에 구분선 추가
      await pasteHorizontalRule(page);
      await page.waitForTimeout(300);
    }
  }

  // 해시태그 (맨 마지막) - 스페이스 제거하여 태그 깨짐 방지
  await page.keyboard.press('Enter');
  const hashtagText = hashtags.map((t: string) => `${t.replace(/\s+/g, '')}`).join(' ');
  await page.keyboard.type(hashtagText, { delay: 10 });

  console.log(`\n   ✅ 총 이미지 ${uploadedCount}개 업로드`);
  console.log(`   ✅ 총 섹션 ${sections.length}개 입력`);
  console.log(`   ✅ 해시태그 ${hashtags.length}개`);
}

// ============================================
// STEP 6.5: 임시 저장
// ============================================
async function step6_5_temporarySave(page: Page): Promise<void> {
  console.log("\n💾 STEP 6.5: 임시 저장 수행");
  try {
    // 저장 버튼 클릭 (data-click-area="tpb.save" 또는 .save_btn__bzc5B)
    const saveBtn = await page.$('button[data-click-area="tpb.save"], .save_btn__bzc5B');
    if (saveBtn) {
      await saveBtn.click();
      console.log("   ✅ 임시 저장 버튼 클릭 완료");
      await page.waitForTimeout(3000); // 저장 처리 대기 시간 약간 상향
    } else {
      throw new Error("임시 저장 버튼을 찾을 수 없습니다.");
    }
  } catch (e) {
    console.log(`   ❌ 임시 저장 중 오류: ${e}`);
  }
}

// ============================================
// STEP 7: 발행 (도움말 닫기 → 발행 버튼 → 설정 → 최종 발행)
// ============================================
async function step7_publish(page: Page): Promise<boolean> {
  console.log("\n🚀 STEP 7: 발행");

  // 1. 도움말/팝업/사이드바 닫기
  console.log("   도움말/팝업 닫기...");
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  // 닫기 버튼들 클릭 시도
  const closeSelectors = [
    '.help_layer button[class*="close"]',
    '.tooltip button[class*="close"]',
    '.guide_layer button[class*="close"]',
    '[class*="close_btn"]',
    '[class*="closeBtn"]',
    'button[aria-label="닫기"]',
    '.se-help-panel-close-button',
  ];

  for (const selector of closeSelectors) {
    const closeBtn = await page.$(selector);
    if (closeBtn) {
      await closeBtn.click().catch(() => { });
      console.log(`   닫기 버튼 클릭: ${selector}`);
      await page.waitForTimeout(300);
    }
  }

  // 페이지 상단으로
  await page.evaluate(`window.scrollTo(0, 0)`);
  await page.waitForTimeout(500);

  // 2. 첫 번째 발행 버튼 클릭 (상단 헤더)
  console.log("   1차 발행 버튼 클릭...");

  // 우측 상단 발행 버튼 (초록색)
  const headerPublishBtn = await page.$('button[class*="publish_btn"], header button[class*="publish"]');
  if (headerPublishBtn) {
    await headerPublishBtn.click({ force: true }).catch(() => { });
    console.log("   ✅ 헤더 발행 버튼 클릭");
  } else {
    // 좌표로 클릭 (우측 상단)
    await page.mouse.click(1210, 22);
    console.log("   ✅ 좌표로 발행 버튼 클릭");
  }

  await page.waitForTimeout(2000);

  // 3. 발행 설정 화면에서 최종 발행 버튼 클릭
  console.log("   2차 최종 발행 버튼...");
  await page.waitForTimeout(1500);

  // 발행 확인 버튼 셀렉터들 (우측 하단 초록색 "발행" 버튼)
  const finalPublishSelectors = [
    'button.confirm_btn__WEaBq',              // 최신 네이버 발행 확인 버튼
    'button[class*="confirm_btn"]',
    'button.btn_publish__FvD4K',
    'button[class*="btn_publish"]',
    '.publish_layer button[class*="confirm"]',
    '.btn_area button:has-text("발행")',
  ];

  for (const selector of finalPublishSelectors) {
    try {
      const btn = await page.$(selector);
      if (btn && await btn.isVisible()) {
        console.log(`   ✅ 최종 발행 버튼 발견: ${selector}`);
        await btn.click({ force: true });
        console.log("   🎉 최종 발행 클릭!");
        await page.waitForTimeout(5000);
        return true;
      }
    } catch { }
  }

  // 4. "발행" 텍스트가 있는 버튼 찾기
  console.log("   텍스트로 발행 버튼 찾기...");
  const publishButtons = await page.$$('button');
  for (const btn of publishButtons) {
    const text = await btn.textContent();
    if (text && text.includes('발행') && !text.includes('예약')) {
      const isVisible = await btn.isVisible();
      if (isVisible) {
        console.log(`   ✅ "발행" 버튼 발견`);
        await btn.click({ force: true });
        console.log("   🎉 최종 발행 클릭!");
        await page.waitForTimeout(5000);
        return true;
      }
    }
  }

  // 5. 좌표로 최종 발행 버튼 클릭 (이미지 참고: 우측 하단 "✓ 발행")
  console.log("   좌표로 최종 발행 버튼 클릭...");
  // 발행 설정 화면 기준 우측 하단 발행 버튼 (약 480, 460 위치)
  await page.mouse.click(480, 455);
  await page.waitForTimeout(2000);

  // 한번 더 시도 (조금 다른 위치)
  await page.mouse.click(470, 450);
  await page.waitForTimeout(3000);

  return true;
}

// ============================================
// 메인 실행
// ============================================
async function main() {
  const linkId = process.argv[2];

  if (!linkId) {
    console.error("사용법: npx ts-node scripts/simple-agent.ts <linkId>");
    process.exit(1);
  }

  console.log("=".repeat(50));
  console.log("🤖 심플 에이전트 시작");
  console.log("=".repeat(50));

  // 세션 확인
  if (!fs.existsSync(SESSION_FILE)) {
    console.error("❌ 네이버 로그인 세션이 없습니다. npm run login 실행하세요.");
    process.exit(1);
  }

  // DB에서 링크 조회
  const link = await prisma.brandLink.findUnique({ where: { id: linkId } });
  if (!link) {
    console.error("❌ 링크를 찾을 수 없습니다.");
    process.exit(1);
  }

  console.log(`\n📎 URL: ${link.url}`);

  // 브라우저 시작 (봇 감지 우회 설정)
  const browser = await chromium.launch({
    headless: false,
    slowMo: 80,  // 더 자연스러운 속도
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const context = await browser.newContext({
    storageState: SESSION_FILE,
    viewport: { width: 1280, height: 900 },
    locale: "ko-KR",
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // 봇 감지 우회 스크립트 (문자열로 전달)
  await page.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
  `);

  try {
    // STEP 1: 상품 정보 + 이미지 수집
    const product = await step1_getProductInfo(page, link.url);

    console.log("\n" + "-".repeat(40));
    console.log(`📦 상품: ${product.name}`);
    console.log(`💰 가격: ${product.price}`);
    console.log(`🖼️ 이미지: ${product.imagePaths.length}개`);
    console.log("-".repeat(40));

    // 상단 소개 이미지 추가 (temp_images/top_intro.png)
    const topIntroPath = path.join(TEMP_PATH, "top_intro.png");
    if (fs.existsSync(topIntroPath)) {
      product.imagePaths.unshift(topIntroPath);
      console.log("   ✨ 상단 소개 이미지 추가 완료 (temp_images/top_intro.png)");
    }

    // STEP 1.5: SEO 분석
    const seoContext = await step1_5_seoAnalysis(product);

    // STEP 2: SEO 최적화 글 생성
    const post = await step2_generatePost(product, link.url, seoContext, "https://my-blog-images.com/banner_disclosure.png");

    // STEP 2.5: 썸네일 기획 생성 및 저장
    const thumbnailPlan = await step2_5_planThumbnail(product, post);
    await prisma.brandLink.update({
      where: { id: linkId },
      data: {
        thumbnailPrompts: JSON.stringify(thumbnailPlan.prompts),
        thumbnailTitles: JSON.stringify(thumbnailPlan.titles)
      }
    });
    console.log("   ✅ 썸네일 기획 완료 및 DB 저장");

    // STEP 3: 에디터 열기
    await step3_openEditor(page);

    // STEP 4: 제목 입력
    await step4_inputTitle(page, post.title);

    // STEP 5+6: 이미지와 본문 번갈아 입력
    await step5and6_uploadAndWrite(page, product.imagePaths, post.sections, post.hashtags);

    // STEP 6.5: 임시 저장
    await step6_5_temporarySave(page);

    // 완료 처리 (임시 저장까지만 수행하므로 여기서 상태 업데이트)
    console.log("\n" + "=".repeat(50));
    console.log("✅ 글 작성 및 임시 저장 완료!");
    console.log(`📦 상품: ${product.name}`);
    console.log(`📝 섹션: ${post.sections.length}개`);
    console.log("=".repeat(50));

    await prisma.brandLink.update({
      where: { id: linkId },
      data: {
        status: "PUBLISHED",
        productName: product.name,
        publishedAt: new Date(),
      }
    });

    /* 
    // [참고] 나중에 아래 주석을 풀면 임시 저장 대신 실제 '발행' 버튼까지 클릭하여 완료합니다.
    
    // STEP 7: 직접 발행 진행
    const published = await step7_publish(page);

    // 결과 확인
    await page.waitForTimeout(3000);
    const currentUrl = page.url();

    if (currentUrl.includes('PostView') || currentUrl.includes('logNo') || published) {
      console.log("\n" + "=".repeat(50));
      console.log("🎉 자동 발행 성공!");
      console.log(`📄 URL: ${currentUrl}`);
      console.log("=".repeat(50));

      await prisma.brandLink.update({
        where: { id: linkId },
        data: {
          postUrl: currentUrl,
        }
      });
    } else {
      console.log("\n⚠️ 발행 결과를 확인하세요. 에디터에서 수동으로 발행을 완료해야 할 수 있습니다.");
    }
    */


    // 임시 파일 정리 (temp_images 내 product_ 로 시작하는 모든 파일 삭제)
    try {
      const files = fs.readdirSync(TEMP_PATH);
      for (const file of files) {
        if (file.startsWith("product_")) {
          const fullPath = path.join(TEMP_PATH, file);
          try { fs.unlinkSync(fullPath); } catch (e) { }
        }
      }
      console.log(`   🧹 임시 이미지 파일(${files.filter(f => f.startsWith("product_")).length}개) 정리 완료`);
    } catch (e) {
      console.log("   ⚠️ 임시 파일 정리 중 오류:", e);
    }

    console.log("\n✅ 모든 작업이 완료되어 브라우저를 종료합니다.");
    await browser.close();

  } catch (error: any) {
    console.error("\n❌ 오류:", error.message);

    await prisma.brandLink.update({
      where: { id: linkId },
      data: { status: "FAILED", errorMessage: error.message }
    });
  } finally {
    await prisma.$disconnect();
  }
}

main();

