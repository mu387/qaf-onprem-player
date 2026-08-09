// Auto-generated from last run for Register_SAP_user
const { Builder, By, Key, until, Browser } = require('selenium-webdriver');

async function main() {
  let driver;
  try {
    driver = await new Builder().forBrowser(Browser.CHROME).build();
    // Set a default implicit wait if desired
    await driver.manage().setTimeouts({ implicit: 10000 });
  await driver.get("https://event.on24.com/wcc/r/4466120/8FB2CEF84645215116DF851DB89DCA51?partnerref=webbanner");
  await driver.findElement(By.xpath("//*[@id=\"onetrust-accept-btn-handler\"]")).click();
  await driver.findElement(By.xpath("//strong[normalize-space()=\"REGISTER\"]")).click();
  // TODO: validateElement mapping may need manual assertions
  await driver.findElement(By.xpath("//div[@class=\"js-fields-container\"]"));
  await driver.findElement(By.xpath("//input[@id=\"firstname\"]")).sendKeys("Demo");
  await driver.findElement(By.xpath("//input[@id=\"lastname\"]")).sendKeys("Test");
  await driver.findElement(By.xpath("//input[@id=\"email\"]")).sendKeys("DemoTest7133@companymail.com");
  await driver.findElement(By.xpath("//input[@id=\"state\"]")).sendKeys("Maryland");
  {
    const el = await driver.findElement(By.xpath("//select[@id=\"country\"]"));
    const select = new (require('selenium-webdriver')).Select(el);
    await select.selectByVisibleText("Algeria");
  }
  {
    const el = await driver.findElement(By.xpath("//select[@id=\"std10\"]"));
    const select = new (require('selenium-webdriver')).Select(el);
    await select.selectByVisibleText("Algeria +213");
  }
  await driver.findElement(By.xpath("//input[@id=\"work_phone\"]")).sendKeys("4352222212");
  await driver.findElement(By.xpath("//input[@id=\"company\"]")).sendKeys("Comapny LLC");
  await driver.findElement(By.xpath("//input[@id=\"job_title\"]")).sendKeys("CEO");
  {
    const el = await driver.findElement(By.xpath("//select[@id=\"std1\"]"));
    const select = new (require('selenium-webdriver')).Select(el);
    await select.selectByVisibleText("Student");
  }
  {
    const el = await driver.findElement(By.xpath("//*[@id=\"std3\"]"));
    const select = new (require('selenium-webdriver')).Select(el);
    await select.selectByVisibleText("Phone");
  }
  // TODO: validateElement mapping may need manual assertions
  await driver.findElement(By.xpath("//input[@id=\"firstname\"]"));
  // TODO: validateElement mapping may need manual assertions
  await driver.findElement(By.xpath("//input[@id=\"lastname\"]"));
  // TODO: validateElement mapping may need manual assertions
  await driver.findElement(By.xpath("//input[@id=\"email\"]"));
  // TODO: validateElement mapping may need manual assertions
  await driver.findElement(By.xpath("//input[@id=\"state\"]"));
  // TODO: validateElement mapping may need manual assertions
  await driver.findElement(By.xpath("//select[@id=\"country\"]"));
  // TODO: validateElement mapping may need manual assertions
  await driver.findElement(By.xpath("//select[@id=\"std10\"]"));
  // TODO: validateElement mapping may need manual assertions
  await driver.findElement(By.xpath("//input[@id=\"work_phone\"]"));
  // TODO: validateElement mapping may need manual assertions
  await driver.findElement(By.xpath("//input[@id=\"company\"]"));
  // TODO: validateElement mapping may need manual assertions
  await driver.findElement(By.xpath("//input[@id=\"job_title\"]"));
  // TODO: validateElement mapping may need manual assertions
  await driver.findElement(By.xpath("//select[@id=\"std1\"]"));
  // TODO: validateElement mapping may need manual assertions
  await driver.findElement(By.xpath("//*[@id=\"std3\"]"));
  } finally {
    if (driver) {
      try { await driver.quit(); } catch (_) {}
    }
  }
}

main().catch(err => { console.error('Test failed', err); process.exitCode = 1; });