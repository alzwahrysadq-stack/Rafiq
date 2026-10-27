package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PaymentRulesTest {

    @Test
    fun validPartsPass() {
        val parts = listOf(
            PaymentRules.Part("transfer", 1500L, "TRX-1"),
            PaymentRules.Part("wallet", 300L, "W-22"),
        )
        assertNull(PaymentRules.validateNonCash(parts))
        assertEquals(1800L, PaymentRules.sumNonCash(parts))
    }

    @Test
    fun referenceIsRequiredForEveryNonCashPart() {
        assertNotNull(PaymentRules.validateNonCash(listOf(PaymentRules.Part("transfer", 500L, ""))))
        assertNotNull(PaymentRules.validateNonCash(listOf(PaymentRules.Part("deposit", 500L, "   "))))
    }

    @Test
    fun amountMustBePositive() {
        assertNotNull(PaymentRules.validateNonCash(listOf(PaymentRules.Part("wallet", 0L, "R1"))))
        assertNotNull(PaymentRules.validateNonCash(listOf(PaymentRules.Part("wallet", -5L, "R1"))))
    }

    @Test
    fun cashAndDebtAreNotAcceptedAsNonCashParts() {
        assertNotNull(PaymentRules.validateNonCash(listOf(PaymentRules.Part("cash", 100L, "x"))))
        assertNotNull(PaymentRules.validateNonCash(listOf(PaymentRules.Part("debt", 100L, "x"))))
    }
}
