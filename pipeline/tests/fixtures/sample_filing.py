"""A hand-written, 10-K-shaped sample filing for development and tests.

"Harbor & Pine Outfitters" is invented. Nothing here is real company data, and it is never loaded into a shared
database. It exercises the real parser: table of contents, page furniture, item headings, nested headings, lists
and tables.
"""

from __future__ import annotations

H1 = "<p><b><u>{}</u></b></p>"
H2 = "<p><b>{}</b></p>"


def p(text: str) -> str:
    return f"<p>{text}</p>"


def table(rows: list[list[str]]) -> str:
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f"<table>{body}</table>"


BUSINESS = [
    H1.format("Overview"),
    p("Harbor &amp; Pine Outfitters, Inc. (&ldquo;we,&rdquo; &ldquo;us&rdquo; or the &ldquo;Company&rdquo;) designs, sources and sells "
      "outdoor apparel, footwear and camping equipment through 412 stores in North America, a network of wholesale partners and "
      "our e-commerce sites. We were founded in 1989 and are headquartered in Portland, Oregon. Our fiscal year ends on the "
      "Saturday closest to January 31."),
    p("Our strategy rests on three priorities: building a product line that lasts longer than the category average, growing "
      "direct-to-consumer sales while keeping our wholesale relationships healthy, and operating a supply chain that can absorb "
      "shocks without passing every cost increase on to customers."),
    H1.format("Products and Brands"),
    H2.format("Apparel and Footwear"),
    p("Apparel and footwear generated 71% of net sales in fiscal 2025. The category includes insulated jackets, base layers, "
      "trail shoes and waterproof boots. Roughly 38% of apparel units sold in fiscal 2025 were made with recycled or "
      "responsibly sourced materials, up from 29% in fiscal 2024."),
    H2.format("Camping Equipment"),
    p("Camping equipment, including tents, sleeping bags and stoves, accounted for 29% of net sales. Equipment has longer "
      "replacement cycles than apparel and carries a higher gross margin, but demand is more sensitive to discretionary "
      "spending and to weather in the peak summer months."),
    H1.format("Customers and Channels"),
    p("We sell directly to consumers in our stores and online, and to roughly 1,900 wholesale doors operated by specialty "
      "retailers and department stores. Direct-to-consumer channels represented 64% of net sales in fiscal 2025. No single "
      "wholesale customer accounted for more than 6% of net sales."),
    H1.format("Competition"),
    p("The outdoor products market is highly competitive and fragmented. We compete with large global sportswear companies, "
      "specialty outdoor brands and a growing number of private-label offerings from major retailers. Competition is based on "
      "product performance, brand reputation, price, availability and the quality of the shopping experience. Several of our "
      "competitors have greater financial resources and broader distribution than we do."),
    H1.format("Seasonality"),
    p("Our business is seasonal. We earn a disproportionate share of operating income in the fourth quarter, when cold-weather "
      "apparel and holiday gifting drive traffic. Inventory builds in the third quarter, which increases working capital needs "
      "and our reliance on seasonal borrowings under our revolving credit facility."),
    H1.format("Human Capital"),
    p("As of the end of fiscal 2025 we employed approximately 9,400 people, of whom 6,100 worked in our stores and 1,300 in our "
      "distribution centers. We hire seasonal associates each fall, and turnover among store associates remains higher than "
      "turnover in our corporate functions."),
]

RISKS = [
    H1.format("Risks Related to Our Supply Chain"),
    H2.format("We depend on a limited number of foreign suppliers"),
    p("We do not own manufacturing facilities. In fiscal 2025, independent factories in Vietnam, Indonesia and China produced "
      "approximately 86% of our products, and our ten largest suppliers accounted for 54% of purchases. A disruption at any of "
      "these suppliers, whether from a labor dispute, a natural disaster, a financial failure or a change in trade policy, "
      "could delay shipments, raise our costs and reduce sales."),
    p("Tariffs and other trade restrictions could increase the cost of our products. If additional duties were imposed on "
      "apparel and footwear imported from the countries where we source, our gross margin would decline unless we could "
      "offset the increase through price changes, supplier concessions or a shift in sourcing, none of which can be "
      "achieved quickly."),
    H2.format("Transportation costs and delays could harm our results"),
    p("We rely on ocean carriers and third-party logistics providers to move product from factories to our distribution "
      "centers. Container shortages, port congestion and fuel price increases have in the past lengthened lead times and "
      "increased freight expense. Higher freight rates reduced our gross margin by approximately 40 basis points in fiscal 2025."),
    H1.format("Risks Related to Our Business and Industry"),
    H2.format("Consumer demand for outdoor products is difficult to predict"),
    p("Demand for our products depends on consumer preferences, weather, and general economic conditions. Unseasonably warm "
      "winters reduce sales of insulated apparel, and a decline in consumer confidence can lead shoppers to postpone "
      "purchases of higher-priced equipment. If we misjudge demand we may carry excess inventory that must be marked down."),
    H2.format("We face intense competition"),
    p("Our competitors may respond more quickly to changes in consumer preferences, adopt more aggressive pricing, or "
      "devote greater resources to marketing. Increased competition could force us to lower prices, increase promotional "
      "spending or lose market share."),
    H1.format("Risks Related to Technology and Data"),
    H2.format("A cybersecurity incident could disrupt operations and damage our reputation"),
    p("We collect and store personal information about our customers and employees, and we rely on information systems to "
      "process orders, manage inventory and operate our stores. A breach, a ransomware attack or a prolonged outage of "
      "these systems could interrupt operations, expose us to legal claims and regulatory penalties, and erode customer trust. "
      "We maintain cyber insurance, but coverage may not be sufficient to cover all losses."),
    H1.format("Financial and Other Risks"),
    H2.format("Currency fluctuations affect our reported results"),
    p("Approximately 22% of our net sales are generated outside the United States, principally in Canada and Europe, while a "
      "large share of our product costs are denominated in U.S. dollars. A stronger dollar reduces the translated value of "
      "our international revenue and can compress margins in markets where we do not adjust prices."),
    H2.format("Our revolving credit facility contains covenants that limit our flexibility"),
    p("Our credit agreement requires us to maintain a minimum fixed charge coverage ratio and restricts additional "
      "indebtedness, dividends and acquisitions. A failure to comply could result in an event of default and accelerate "
      "amounts outstanding."),
]

MDNA = [
    H1.format("Overview"),
    p("Net sales for fiscal 2025 were $3.84 billion, an increase of 6.1% from $3.62 billion in fiscal 2024. Comparable sales "
      "increased 3.4%, driven by growth in direct-to-consumer channels and higher average selling prices, partially offset "
      "by lower wholesale volumes. Operating income was $412 million, or 10.7% of net sales, compared with $371 million, or "
      "10.2% of net sales, in fiscal 2024."),
    H1.format("Results of Operations"),
    table([
        ["(in millions)", "Fiscal 2025", "Fiscal 2024", "Change"],
        ["Net sales", "$3,841", "$3,620", "6.1%"],
        ["Gross profit", "$1,689", "$1,555", "8.6%"],
        ["Selling, general and administrative", "$1,277", "$1,184", "7.9%"],
        ["Operating income", "$412", "$371", "11.1%"],
    ]),
    p("Gross margin was 44.0% in fiscal 2025, an increase of 100 basis points from 43.0% in fiscal 2024. The improvement "
      "reflected a favorable mix toward higher-margin direct-to-consumer sales and lower promotional activity, partially "
      "offset by approximately 40 basis points of higher freight costs."),
    H2.format("Direct-to-Consumer"),
    p("Direct-to-consumer net sales increased 9.2% to $2.46 billion. Store sales grew 4.8% on higher traffic and conversion, "
      "and e-commerce sales grew 15.3%, led by mobile. We opened 18 new stores and closed 6 in fiscal 2025."),
    H2.format("Wholesale"),
    p("Wholesale net sales decreased 1.7% to $1.38 billion as several department store partners reduced inventory and "
      "narrowed their outdoor assortments. Excluding the impact of those reductions, wholesale sales grew 2.1%."),
    H1.format("Liquidity and Capital Resources"),
    p("Cash and cash equivalents were $486 million at the end of fiscal 2025. Cash provided by operating activities was "
      "$534 million, compared with $447 million in fiscal 2024, reflecting higher net income and a smaller increase in "
      "inventory. Capital expenditures were $168 million, primarily for new stores, distribution center automation and "
      "technology investments."),
    p("We had no borrowings outstanding under our $750 million revolving credit facility at year end, and we were in "
      "compliance with all financial covenants. We returned $215 million to shareholders through dividends and share "
      "repurchases during the year."),
    H1.format("Outlook"),
    p("For fiscal 2026 we expect net sales growth of 4% to 6% and operating margin broadly in line with fiscal 2025. This "
      "outlook assumes freight rates remain near current levels and that no new tariffs are imposed on our principal "
      "sourcing countries."),
]

MARKET = [
    H1.format("Foreign Currency Risk"),
    p("A hypothetical 10% strengthening of the U.S. dollar against the Canadian dollar and the euro would have reduced "
      "fiscal 2025 net sales by approximately $62 million and operating income by approximately $9 million. We do not "
      "hedge translation exposure but use forward contracts to hedge a portion of forecasted inventory purchases."),
    H1.format("Interest Rate Risk"),
    p("Borrowings under our credit facility bear interest at variable rates. Because we had no borrowings outstanding at "
      "year end, a 100 basis point change in interest rates would not have had a material effect on our interest expense."),
    H1.format("Commodity Price Risk"),
    p("Cotton, down, nylon and polyester are significant inputs to our products. Price changes in these materials affect "
      "our cost of goods, with a lag of two to three seasons because of our purchasing commitments."),
]


BUSINESS += [
    H1.format("Intellectual Property"),
    p("We own trademarks, patents and trade dress covering our principal brands and several fabric and insulation "
      "technologies. We enforce our rights against counterfeit goods, which are sold primarily through online marketplaces. "
      "The loss of a key trademark would harm our brand, but we do not consider any single patent material to our business."),
    H1.format("Regulation"),
    p("Our products are subject to consumer product safety, labeling and chemical content regulations in the markets "
      "where we sell. Our operations are subject to wage and hour, privacy and environmental laws. Compliance costs have "
      "not been material, but new requirements, particularly on chemical use in waterproofing treatments, could require "
      "us to reformulate products."),
]

RISKS += [
    H1.format("Legal, Regulatory and Environmental Risks"),
    H2.format("Climate change and severe weather may reduce demand and disrupt operations"),
    p("Changing weather patterns can shorten the winter season and alter demand for cold-weather products. Severe storms, "
      "wildfires and flooding can close stores and distribution centers or interrupt our suppliers. In fiscal 2025 two "
      "distribution centers were closed for a combined nine days because of weather, delaying approximately $28 million "
      "of shipments."),
    H2.format("Labor costs and availability could adversely affect our stores"),
    p("Our stores depend on a large workforce. Minimum wage increases, competition for retail talent and efforts to "
      "unionize could raise our labor costs. Selling, general and administrative expense included $38 million of "
      "additional store wages in fiscal 2025."),
    H2.format("We may be unable to protect our intellectual property"),
    p("Counterfeit products and unauthorized use of our trademarks could dilute our brands. Enforcement is costly, and "
      "legal protection varies by country. An adverse ruling in a dispute over a patent or trademark could require us to "
      "pay damages or change our products."),
    H2.format("Product safety issues could lead to recalls and liability"),
    p("Defects in our equipment, such as stoves or climbing hardware, could injure users and result in recalls, product "
      "liability claims and reputational harm. Our insurance may not fully cover such claims."),
]

MDNA += [
    H1.format("Critical Accounting Estimates"),
    p("Inventory is stated at the lower of cost and net realizable value. We estimate net realizable value using "
      "historical sell-through, current inventory levels and expected markdowns, and a 10% change in our markdown "
      "assumptions for aged inventory would have changed cost of goods sold by approximately $14 million."),
    p("We test goodwill and indefinite-lived trademarks for impairment annually. The fair value of each reporting unit "
      "exceeded its carrying value by more than 25% at the most recent test date."),
]

MARKET += [
    H1.format("Inflation"),
    p("Inflation affects our product costs, freight, wages and occupancy. We attempt to offset higher costs through "
      "pricing, productivity and sourcing, but we may not be able to do so fully or promptly. Average selling prices "
      "increased approximately 2% in fiscal 2025 while unit volumes were broadly flat."),
    H1.format("Counterparty and Credit Risk"),
    p("We are exposed to credit risk from our wholesale customers and from the financial institutions that are "
      "counterparties to our derivative contracts and hold our cash. We monitor the creditworthiness of wholesale "
      "customers, maintain an allowance for doubtful accounts of $11 million, and limit cash and derivative exposure to "
      "institutions with investment-grade ratings. We do not currently expect any counterparty to fail to perform."),
    H1.format("Derivative Instruments"),
    p("We use foreign currency forward contracts with notional amounts of $210 million to hedge a portion of forecasted "
      "inventory purchases. The fair value of these contracts was a net asset of $6 million at year end, and gains and "
      "losses are recognized in cost of goods sold when the hedged inventory is sold."),
]


def item(title: str, body: list[str]) -> str:
    filler = "<p>" + ("&nbsp;" * 3) + "</p>"
    return H2.format(title) + "".join(body) + filler


# Fiscal 2024 version of the same invented company: the same text with earlier-year figures.
FY2024_SUBSTITUTIONS = [
    ("fiscal 2025", "fiscal 2024"), ("fiscal 2024 to", "fiscal 2023 to"), ("Fiscal 2025", "Fiscal 2024"),
    ("71% of net sales", "70% of net sales"), ("38% of apparel units", "29% of apparel units"),
    ("29% of net sales", "30% of net sales"), ("64% of net sales", "61% of net sales"), ("412 stores", "400 stores"),
    ("86% of our products", "81% of our products"), ("54% of purchases", "52% of purchases"),
    ("40 basis points", "10 basis points"), ("$3.84 billion", "$3.62 billion"), ("$3.62 billion", "$3.41 billion"),
    ("$412 million", "$371 million"), ("10.7% of net sales", "10.2% of net sales"), ("6.1%", "5.3%"),
    ("3.4%", "2.1%"), ("44.0%", "43.0%"), ("9.2%", "7.9%"), ("15.3%", "12.8%"), ("$2.46 billion", "$2.25 billion"),
    ("$486 million", "$431 million"), ("$534 million", "$447 million"), ("$168 million", "$151 million"),
    ("9,400 people", "9,100 people"), ("22% of our net sales", "21% of our net sales"),
]


def sample_filing_html(fiscal_year: int = 2025) -> bytes:
    toc = "".join(f"<p>{label}</p>" for label in (
        "Item 1. Business", "Item 1A. Risk Factors", "Item 7. Management&rsquo;s Discussion and Analysis",
        "Item 7A. Quantitative and Qualitative Disclosures About Market Risk"))
    html = (
        "<html><body>"
        "<div style='display:none'><ix:header>hidden facts</ix:header></div>"
        "<p style='text-align:center'><b>UNITED STATES SECURITIES AND EXCHANGE COMMISSION</b></p>"
        "<p style='text-align:center'><b>FORM 10-K</b></p>"
        "<p>Table of Contents</p>" + toc + "<p>Page 3</p>"
        + item("Item 1. Business", BUSINESS)
        + "<p>Page 14</p>"
        + item("Item 1A. Risk Factors", RISKS)
        + "<p>Page 28</p>"
        + item("Item 1B. Unresolved Staff Comments", [p("None.")])
        + item("Item 7. Management&rsquo;s Discussion and Analysis of Financial Condition and Results of Operations", MDNA)
        + item("Item 7A. Quantitative and Qualitative Disclosures About Market Risk", MARKET)
        + item("Item 8. Financial Statements and Supplementary Data", [p("Omitted from the in-scope text.")])
        + "</body></html>"
    )
    if fiscal_year == 2024:
        for old, new in FY2024_SUBSTITUTIONS:
            html = html.replace(old, new)
    return html.encode("utf-8")
