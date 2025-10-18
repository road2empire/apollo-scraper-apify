import { Actor } from 'apify';
import { chromium } from 'playwright';

// Function to extract table data from the page
async function extractTableData(page) {
    return await page.evaluate(() => {
        const table = document.querySelector('table');
        if (!table) {
            return [];
        }

        const rows = Array.from(table.querySelectorAll('tr'));
        const data = [];

        // Skip header row (first row)
        for (let i = 1; i < rows.length; i++) {
            const cells = Array.from(rows[i].querySelectorAll('td'));
            if (cells.length === 0) continue;

            const rowData = {};
            
            // Extract text from each cell
            cells.forEach((cell, index) => {
                // Remove SVGs, images, buttons, and checkboxes
                const clonedCell = cell.cloneNode(true);
                const elementsToRemove = clonedCell.querySelectorAll('svg, img, button, input[type="checkbox"]');
                elementsToRemove.forEach(el => el.remove());
                
                let text = clonedCell.textContent.trim();
                
                // Format phone numbers
                const phoneRegex = /\+\d{11}/g;
                const phoneMatches = text.match(phoneRegex);
                if (phoneMatches) {
                    phoneMatches.forEach(match => {
                        const formatted = match.replace(/(\+\d{1})(\d{3})(\d{3})(\d{4})/, '$1 ($2) $3-$4');
                        text = text.replace(match, formatted);
                    });
                }
                
                // Clean up text
                text = text.replace(/[^a-zA-Z0-9\s,.@()-]/g, '').replace(/Â/g, '').trim();
                
                // Map to column names based on typical Apollo.io table structure
                switch(index) {
                    case 0: // Usually checkbox column, skip
                        break;
                    case 1: // Name column
                        if (text && text !== 'Name') {
                            const names = text.split(' ');
                            rowData.firstName = names[0] || '';
                            rowData.lastName = names.slice(1).join(' ') || '';
                            rowData.fullName = text;
                        }
                        break;
                    case 2: // Title
                        rowData.title = text || '';
                        break;
                    case 3: // Company
                        rowData.company = text || '';
                        break;
                    case 4: // Email
                        if (text && text !== 'No email' && text !== 'NA') {
                            rowData.email = text;
                        }
                        break;
                    case 5: // Phone
                        if (text && text !== 'Request Mobile Number' && text !== 'NA') {
                            rowData.phone = text;
                        }
                        break;
                    default:
                        // Store additional columns
                        rowData[`column_${index}`] = text;
                }
            });

            // Only add row if it has meaningful data
            if (rowData.fullName || rowData.email) {
                data.push(rowData);
            }
        }

        return data;
    });
}

// Main actor code
await Actor.main(async () => {
    // Get input from the actor
    const input = await Actor.getInput();
    
    if (!input || !input.url) {
        throw new Error('Input must contain a valid Apollo.io URL!');
    }

    const { 
        url, 
        numberOfPages = 1, 
        timeBetweenPages = 5,
        proxyConfiguration = { useApifyProxy: true },
        cookies = []
    } = input;

    // Validate URL
    if (!url.includes('https://app.apollo.io/')) {
        throw new Error('URL must be a valid Apollo.io list URL (https://app.apollo.io/...)');
    }

    // Check if cookies are provided
    if (!cookies || cookies.length === 0) {
        console.log('WARNING: No cookies provided. Scraping may fail without authentication!');
    } else {
        console.log(`Loaded ${cookies.length} cookies for authentication`);
    }

    // Limit pages to 100
    const maxPages = Math.min(numberOfPages, 100);
    
    console.log(`Starting Apollo.io scraper...`);
    console.log(`URL: ${url}`);
    console.log(`Pages to scrape: ${maxPages}`);
    console.log(`Time between pages: ${timeBetweenPages} seconds`);

    // Launch browser
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });

        // Add cookies to the browser context
        if (cookies && cookies.length > 0) {
            // Convert cookies to Playwright format
            const playwrightCookies = cookies.map(cookie => ({
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path || '/',
                expires: cookie.expirationDate ? cookie.expirationDate : -1,
                httpOnly: cookie.httpOnly || false,
                secure: cookie.secure || false,
                sameSite: cookie.sameSite === 'no_restriction' ? 'None' : 
                         cookie.sameSite === 'lax' ? 'Lax' : 
                         cookie.sameSite === 'strict' ? 'Strict' : 'None'
            }));

            await context.addCookies(playwrightCookies);
            console.log('Cookies loaded successfully into browser context');
        }

        const page = await context.newPage();

        // Generate page URLs
        const pageUrls = [];
        let baseUrl = url.replace(/&page=\d+/, '').replace(/\?page=\d+/, '');
        
        for (let i = 1; i <= maxPages; i++) {
            // Add page parameter
            const separator = baseUrl.includes('?') ? '&' : '?';
            const pageUrl = `${baseUrl}${separator}page=${i}`;
            pageUrls.push(pageUrl);
        }

        console.log(`Generated ${pageUrls.length} page URLs to scrape`);

        let allData = [];

        // Scrape each page
        for (let i = 0; i < pageUrls.length; i++) {
            const pageUrl = pageUrls[i];
            console.log(`Scraping page ${i + 1}/${pageUrls.length}: ${pageUrl}`);

            try {
                // Navigate to the page
                await page.goto(pageUrl, { 
                    waitUntil: 'networkidle',
                    timeout: 60000 
                });

                // Wait for table to load
                await page.waitForSelector('table', { timeout: 30000 });

                // Give it a bit more time to ensure all data is loaded
                await page.waitForTimeout(3000);

                // Extract data from the table
                const pageData = await extractTableData(page);
                
                console.log(`Extracted ${pageData.length} contacts from page ${i + 1}`);
                
                allData = allData.concat(pageData);

                // Wait between pages (except for the last page)
                if (i < pageUrls.length - 1) {
                    console.log(`Waiting ${timeBetweenPages} seconds before next page...`);
                    await page.waitForTimeout(timeBetweenPages * 1000);
                }

            } catch (error) {
                console.error(`Error scraping page ${i + 1}:`, error.message);
                // Continue with next page even if this one fails
            }
        }

        // Save all data to dataset
        console.log(`Total contacts scraped: ${allData.length}`);
        
        if (allData.length > 0) {
            await Actor.pushData(allData);
            console.log('Data saved to dataset successfully!');
        } else {
            console.log('No data was scraped. Please check if the URL is correct and accessible.');
        }

        // Set output
        await Actor.setValue('OUTPUT', {
            success: true,
            totalContacts: allData.length,
            pagesScraped: pageUrls.length,
            message: `Successfully scraped ${allData.length} contacts from ${pageUrls.length} pages`
        });

    } catch (error) {
        console.error('Error during scraping:', error);
        throw error;
    } finally {
        await browser.close();
    }

    console.log('Scraping completed!');
});
