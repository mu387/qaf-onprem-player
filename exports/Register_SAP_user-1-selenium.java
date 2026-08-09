// Auto-generated from last run for Register_SAP_user
import org.openqa.selenium.*;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.edge.EdgeDriver;
import org.openqa.selenium.firefox.FirefoxDriver;
import org.openqa.selenium.support.ui.*;
import org.openqa.selenium.WindowType;
import org.testng.annotations.*;
import java.time.Duration;
import static org.testng.Assert.*;

public class Register_SAP_user {
  private WebDriver driver;

  @BeforeClass
  public void setUp() {
    switch ("CHROME") {
      case "FIREFOX": driver = new FirefoxDriver(); break;
      case "EDGE": driver = new EdgeDriver(); break;
      default: driver = new ChromeDriver();
    }
    driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(10));
  }

  @AfterClass
  public void tearDown() {
    if (driver != null) {
      try { driver.quit(); } catch (Exception ignored) {}
    }
  }

  @Test
  public void runTest() throws Exception {
    driver.get("https://event.on24.com/wcc/r/4466120/8FB2CEF84645215116DF851DB89DCA51?partnerref=webbanner");
    new WebDriverWait(driver, Duration.ofSeconds(10)).until(ExpectedConditions.elementToBeClickable(By.xpath("//*[@id=\"onetrust-accept-btn-handler\"]"))).click();
    new WebDriverWait(driver, Duration.ofSeconds(10)).until(ExpectedConditions.elementToBeClickable(By.xpath("//strong[normalize-space()=\"REGISTER\"]"))).click();
    validateElement("//div[@class=\"js-fields-container\"]", "innerText=This is a required fieldFirst Name*This is a required fieldLast Name*This is a required fieldBusiness e-mail address*StateCountry*AfghanistanAlbaniaAlgeriaAmerican SamoaAndorraAngolaAnguillaAntigua and BarbudaArgentinaArmeniaArubaAustraliaAustriaAzerbaijanBahamasBahrainBangladeshBarbadosBelarusBelgiumBelizeBeninBermudaBhutanBoliviaBonaire, Sint Eustatius and SabaBosnia and HerzegovinaBotswanaBouvet IslandBrazilBritish Indian Ocean TerritoryBritish Virgin IslandsBrunei DarussalamBulgariaBurkina FasoBurundiCambodiaCameroonCanadaCape VerdeCayman IslandsCentral African RepublicChadChileChinaChristmas IslandCocos (Keeling) IslandsColombiaComorosCongoCook IslandsCosta RicaCroatiaCuracaoCyprusCzechiaDemocratic Republic of the CongoDenmarkDjiboutiDominicaDominican RepublicEcuadorEgyptEl SalvadorEquatorial GuineaEritreaEstoniaEswatiniEthiopiaFalkland IslandsFaroe IslandsFijiFinlandFranceFrench GuianaFrench PolynesiaFrench Southern TerritoriesGabonGambiaGeorgiaGermanyGhanaGibraltarGreeceGreenlandGrenadaGuadeloupeGuamGuatemalaGuernseyGuineaGuinea-BissauGuyanaHaitiHondurasHong KongHungaryIcelandIndiaIndonesiaIraqIrelandIsle of ManIsraelItalyIvory CoastJamaicaJapanJerseyJordanKazakhstanKenyaKiribatiKuwaitKyrgyzstanLaosLatviaLebanonLesothoLiberiaLibyaLiechtensteinLithuaniaLuxembourgMacaoMacedoniaMadagascarMalawiMalaysiaMaldivesMaliMaltaMarshall IslandsMartiniqueMauritaniaMauritiusMayotteMexicoMicronesiaMoldovaMonacoMongoliaMontenegroMontserratMoroccoMozambiqueMyanmarNamibiaNauruNepalNetherlandsNew CaledoniaNew ZealandNicaraguaNigerNigeriaNiueNorfolk IslandNorthern Mariana IslandsNorwayOmanPakistanPalauPalestinePanamaPapua New GuineaParaguayPeruPhilippinesPitcairn IslandsPolandPortugalPuerto RicoQatarReunionRomaniaRussian FederationRwandaSaint BarthelemySaint HelenaSaint Kitts and NevisSaint LuciaSaint Martin (French)Saint Pierre and MiquelonSaint Vincent and the GrenadinesSamoaSan MarinoSao Tome and PrincipeSaudi ArabiaSenegalSerbiaSeychellesSierra LeoneSingaporeSint Maarten (Dutch)SlovakiaSloveniaSolomon IslandsSomaliaSouth AfricaSouth KoreaSouth SudanSpainSri LankaSudanSurinameSvalbard and Jan MayenSwedenSwitzerlandTaiwanTajikistanTanzaniaThailandTimor-LesteTogoTokelauTongaTrinidad and TobagoTunisiaTurkeyTurkmenistanTurks and Caicos IslandsTuvaluUgandaUkraineUnited Arab EmiratesUnited KingdomUnited States Minor Outlying IslandsUnited StatesUruguayUS Virgin IslandsUzbekistanVanuatuVatican CityVenezuelaVietnamWallis and FutunaWestern SaharaYemenZambiaZimbabweCountry CodePlease Select OneAfghanistan +93Albania +355Algeria +213American Samoa +1-684Andorra +376Angola +244Anguilla +1-264Antarctica +672Antigua and Barbuda +1-268Argentina +54Armenia +374Aruba +297Australia +61Austria +43Azerbaijan +994Bahamas +1-242Bahrain +973Bangladesh +880Barbados +1-246Belarus +375Belgium +32Belize +501Benin +229Bermuda +1-441Bhutan +975Bolivia +591Bosnia and Herzegovina +387Botswana +267Brazil +55British Indian Ocean Territory +246British Virgin Islands +1-284Brunei +673Bulgaria +359Burkina Faso +226Burundi +257Cambodia +855Cameroon +237Canada +1Cape Verde +238Cayman Islands +1-345Central African Republic +236Chad +235Chile +56China +86Christmas Island +61Cocos Islands +61Colombia +57Comoros +269Cook Islands +682Costa Rica +506Croatia +385Curacao +599Cyprus +357Czech Republic +420Democratic Republic of the Congo +243Denmark +45Djibouti +253Dominica +1-767Dominican Republic +1-809, 1-829, 1-849East Timor +670Ecuador +593Egypt +20El Salvador +503Equatorial Guinea +240Eritrea +291Estonia +372Ethiopia +251Falkland Islands +500Faroe Islands +298Fiji +679Finland +358France +33French Polynesia +689Gabon +241Gambia +220Georgia +995Germany +49Ghana +233Gibraltar +350Greece +30Greenland +299Grenada +1-473Guam +1-671Guatemala +502Guernsey +44-1481Guinea +224Guinea-Bissau +245Guyana +592Haiti +509Honduras +504Hong Kong +852Hungary +36Iceland +354India +91Indonesia +62Iraq +964Ireland +353Isle of Man +44-1624Israel +972Italy +39Ivory Coast +225Jamaica +1-876Japan +81Jersey +44-1534Jordan +962Kazakhstan +7Kenya +254Kiribati +686Kosovo +383Kuwait +965Kyrgyzstan +996Laos +856Latvia +371Lebanon +961Lesotho +266Liberia +231Libya +218Liechtenstein +423Lithuania +370Luxembourg +352Macau +853Macedonia +389Madagascar +261Malawi +265Malaysia +60Maldives +960Mali +223Malta +356Marshall Islands +692Mauritania +222Mauritius +230Mayotte +262Mexico +52Micronesia +691Moldova +373Monaco +377Mongolia +976Montenegro +382Montserrat +1-664Morocco +212Mozambique +258Myanmar +95Namibia +264Nauru +674Nepal +977Netherlands +31Netherlands Antilles +599New Caledonia +687New Zealand +64Nicaragua +505Niger +227Nigeria +234Niue +683Northern Mariana Islands +1-670Norway +47Oman +968Pakistan +92Palau +680Palestine +970Panama +507Papua New Guinea +675Paraguay +595Peru +51Philippines +63Pitcairn +64Poland +48Portugal +351Puerto Rico +1-787, 1-939Qatar +974Republic of the Congo +242Reunion +262Romania +40Russia +7Rwanda +250Saint Barthelemy +590Saint Helena +290Saint Kitts and Nevis +1-869Saint Lucia +1-758Saint Martin +590Saint Pierre and Miquelon +508Saint Vincent and the Grenadines +1-784Samoa +685San Marino +378Sao Tome and Principe +239Saudi Arabia +966Senegal +221Serbia +381Seychelles +248Sierra Leone +232Singapore +65Sint Maarten +1-721Slovakia +421Slovenia +386Solomon Islands +677Somalia +252South Africa +27South Korea +82South Sudan +211Spain +34Sri Lanka +94Sudan +249Suriname +597Svalbard and Jan Mayen +47Swaziland +268Sweden +46Switzerland +41Taiwan +886Tajikistan +992Tanzania +255Thailand +66Togo +228Tokelau +690Tonga +676Trinidad and Tobago +1-868Tunisia +216Turkey +90Turkmenistan +993Turks and Caicos Islands +1-649Tuvalu +688U.S. Virgin Islands +1-340Uganda +256Ukraine +380United Arab Emirates +971United Kingdom +44United States +1Uruguay +598Uzbekistan +998Vanuatu +678Vatican +379Venezuela +58Vietnam +84Wallis and Futuna +681Western Sahara +212Yemen +967Zambia +260Zimbabwe +263PhoneThis is a required fieldCompany*This is a required fieldJob Title*Relationship to SAP*Please Select OneCustomerProspective CustomerConsultantInvestor / ShareholderPartnerProspective PartnerAnalyst / PressSAP EmployeeStudentThis is a required fieldSAP will use the data provided hereunder in accordance with the SAP Privacy Statement.");
    find("//input[@id=\"firstname\"]").sendKeys("Demo");
    find("//input[@id=\"lastname\"]").sendKeys("Test");
    find("//input[@id=\"email\"]").sendKeys("DemoTest1875@companymail.com");
    find("//input[@id=\"state\"]").sendKeys("Maryland");
    {
      Select select = new Select(find("//select[@id=\"country\"]"));
      select.selectByVisibleText("Algeria");
    }
    {
      Select select = new Select(find("//select[@id=\"std10\"]"));
      select.selectByVisibleText("Algeria +213");
    }
    find("//input[@id=\"work_phone\"]").sendKeys("4352222212");
    find("//input[@id=\"company\"]").sendKeys("Comapny LLC");
    find("//input[@id=\"job_title\"]").sendKeys("CEO");
    {
      Select select = new Select(find("//select[@id=\"std1\"]"));
      select.selectByVisibleText("Student");
    }
    {
      Select select = new Select(find("//*[@id=\"std3\"]"));
      select.selectByVisibleText("Phone");
    }
    validateElement("//input[@id=\"firstname\"]", "value=Demo");
    validateElement("//input[@id=\"lastname\"]", "value=Test");
    validateElement("//input[@id=\"email\"]", "value=DemoTest1875@companymail.com");
    validateElement("//input[@id=\"state\"]", "value=Maryland");
    validateElement("//select[@id=\"country\"]", "value=Algeria");
    validateElement("//select[@id=\"std10\"]", "value=Algeria +213");
    validateElement("//input[@id=\"work_phone\"]", "value=4352222212");
    validateElement("//input[@id=\"company\"]", "value=Comapny LLC");
    validateElement("//input[@id=\"job_title\"]", "value=CEO");
    validateElement("//select[@id=\"std1\"]", "value=Student");
    validateElement("//*[@id=\"std3\"]", "value=Phone");
  }

  private WebElement find(String xpath) {
    return driver.findElement(By.xpath(xpath));
  }

  private void validateElement(String xpath, String rawValue) {
    WebElement el = find(xpath);
    String attr = "innerText";
    String expected = rawValue == null ? "" : rawValue;
    if (rawValue != null && rawValue.contains("=")) {
      int idx = rawValue.indexOf("=");
      attr = rawValue.substring(0, idx);
      expected = rawValue.substring(idx + 1);
    }
    Object actual;
    switch (attr) {
      case "isSelected": actual = el.isSelected(); break;
      case "isEnabled": actual = el.isEnabled(); break;
      case "isDisplayed": actual = el.isDisplayed(); break;
      case "getText": actual = el.getText(); break;
      case "selection":
        WebElement opt = el.findElement(By.cssSelector("option:checked"));
        actual = opt.getText();
        break;
      default:
        actual = el.getAttribute(attr);
    }
    String actualStr = actual == null ? "" : actual.toString();
    if (actualStr.contains("\n") || actualStr.contains("\r")) {
      actualStr = actualStr.replace("\n", "").replace("\r", "");
    }
    String expectedStr = expected == null ? "" : expected;
    if (!actualStr.equals(expectedStr)) {
      throw new AssertionError("Validation failed for " + attr + ": expected '" + expectedStr + "' got '" + actualStr + "'");
    }
  }
}